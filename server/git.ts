import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import type { Config } from './config';
import type { Conversation } from './store';
import { agentEnvironment } from './runner';
const exec = promisify(execFile);
export class GitError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface GitBranch {
  ref: string;
  name: string;
  remote: boolean;
}
export interface GitView {
  ready: boolean;
  repository: string | null;
  branch: string | null;
  head: string | null;
  detached: boolean;
  changedFiles: number;
  branches: GitBranch[];
  blocked: string | null;
}
export class GitService {
  constructor(private config: Config) {}
  async command(cwd: string, args: string[], signal?: AbortSignal, raw = false) {
    try {
      const result = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd,
        env: {
          ...agentEnvironment(this.config),
          GIT_OPTIONAL_LOCKS: '0',
          GIT_LITERAL_PATHSPECS: '1',
        },
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
        signal,
      });
      return raw ? result.stdout : result.stdout.trimEnd();
    } catch (error: any) {
      // Do not return stderr: remotes may contain credentials or private filesystem paths.
      if (error.name === 'AbortError') throw error;
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        throw new GitError(
          413,
          'Differenza troppo grande da visualizzare. Seleziona un file più piccolo.',
        );
      throw new GitError(
        409,
        'Operazione Git non riuscita. Aggiorna lo stato e riprova; controlla il repository se il problema persiste.',
      );
    }
  }
  async view(chat: Conversation, signal?: AbortSignal): Promise<GitView> {
    const empty: GitView = {
      ready: false,
      repository: chat.repo,
      branch: null,
      head: null,
      detached: false,
      changedFiles: 0,
      branches: [],
      blocked: null,
    };
    if (!chat.workspace) return empty;
    let root: string;
    try {
      root = await this.command(chat.workspace, ['rev-parse', '--show-toplevel'], signal);
    } catch (error) {
      if (error instanceof GitError && !chat.repo) return empty;
      throw error;
    }
    if ((await realpath(root)) !== (await realpath(chat.workspace)))
      throw new GitError(409, 'La cartella della chat non coincide con la radice del repository.');
    const [branch, head, status, refs] = await Promise.all([
      this.command(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal).catch(() => null),
      this.command(root, ['rev-parse', '--verify', 'HEAD'], signal).catch(() => null),
      this.command(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal),
      this.command(
        root,
        [
          'for-each-ref',
          '--sort=refname',
          '--format=%(refname)%00%(symref)',
          'refs/heads/',
          'refs/remotes/',
        ],
        signal,
      ),
    ]);
    // Renames have an additional NUL-delimited source path; count entries, not path fragments.
    const paths = status.split('\0');
    let changedFiles = 0;
    for (let i = 0; i < paths.length; i++)
      if (paths[i]) {
        changedFiles++;
        if (/^[RC]|^.[RC]/.test(paths[i])) i++;
      }
    const branches = refs
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const [ref, symbolic] = line.split('\0');
        if (symbolic || ref.endsWith('/HEAD')) return [];
        const remote = ref.startsWith('refs/remotes/');
        return [
          { ref, name: ref.replace(remote ? /^refs\/remotes\// : /^refs\/heads\//, ''), remote },
        ];
      });
    return {
      ...empty,
      ready: true,
      branch,
      head,
      detached: !branch && !!head,
      changedFiles,
      branches,
    };
  }
  async change(
    chat: Conversation,
    action: { branch?: string; name?: string; base?: string },
    signal?: AbortSignal,
  ) {
    const state = await this.view(chat, signal);
    if (!state.ready) throw new GitError(409, 'Prepara prima il repository.');
    if (state.changedFiles)
      throw new GitError(
        409,
        'Ci sono modifiche locali. Chiedi all’agente di salvarle in un commit prima di cambiare o creare un branch.',
      );
    const cwd = chat.workspace!;
    if (action.name !== undefined) {
      const name = action.name;
      if (!name || name.length > 160 || name.startsWith('-') || name === 'HEAD')
        throw new GitError(400, 'Nome del branch non valido.');
      try {
        await this.command(cwd, ['check-ref-format', `refs/heads/${name}`], signal);
      } catch {
        throw new GitError(400, 'Nome del branch non valido. Usa per esempio feature/notifiche.');
      }
      if (state.branches.some((b) => !b.remote && b.name === name))
        throw new GitError(409, 'Esiste già un branch locale con questo nome.');
      const base =
        action.base === 'HEAD'
          ? state.head
          : state.branches.find((b) => b.ref === action.base)?.ref;
      if (!base)
        throw new GitError(
          409,
          'Il punto di partenza non è disponibile. Aggiorna i branch; il repository deve avere almeno un commit.',
        );
      await this.command(cwd, ['switch', '--no-guess', '--no-track', '-c', name, base], signal);
    } else {
      const target = state.branches.find((b) => b.ref === action.branch);
      if (!target) throw new GitError(409, 'Branch non trovato. Aggiorna l’elenco e riprova.');
      if (target.remote) {
        const local = target.name.slice(target.name.indexOf('/') + 1);
        if (state.branches.some((b) => !b.remote && b.name === local))
          throw new GitError(
            409,
            `Esiste già il branch locale ${local}. Selezionalo nell’elenco Locali.`,
          );
        await this.command(
          cwd,
          ['switch', '--no-guess', '--track', '-c', local, target.ref],
          signal,
        );
      } else await this.command(cwd, ['switch', '--no-guess', '--', target.name], signal);
    }
  }
}
