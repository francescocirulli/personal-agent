import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Conversation } from './store';
import { GitService, GitError, type GitView } from './git';

export interface DiffFile {
  path: string;
  previousPath?: string;
  status: string;
  untracked?: boolean;
  indexOnly?: boolean;
}
export interface DiffView {
  git: GitView;
  mode: 'local' | 'branch';
  base: string | null;
  comparison: string | null;
  files: DiffFile[];
  total: number;
  limited: boolean;
}
export interface FileDiff {
  patch: string;
  binary: boolean;
  limited: boolean;
  note?: string;
}
const MAX_FILE = 1024 * 1024;
const MAX_PATCH = 200000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const options = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames'];

// Only Git-enumerated paths may be requested. Literal pathspecs also protect names
// containing wildcards or Git magic. Neither comparison changes the index or files.
export class GitDiffService {
  constructor(private git: GitService) {}

  async view(chat: Conversation, mode: 'local' | 'branch', requested?: string): Promise<DiffView> {
    const state = await this.git.view(chat);
    const empty: DiffView = {
      git: state,
      mode,
      base: null,
      comparison: null,
      files: [],
      total: 0,
      limited: false,
    };
    if (!state.ready) return empty;
    const cwd = chat.workspace!;
    let base: string | null = null;
    let comparison = state.head || EMPTY_TREE;
    if (mode === 'branch') {
      const defaultRef = await this.git
        .command(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
        .catch(() => '');
      base =
        requested ||
        state.branches.find((b) => b.ref === defaultRef)?.ref ||
        state.branches.find((b) => b.ref === 'refs/heads/main')?.ref ||
        state.branches.find((b) => b.ref === 'refs/heads/master')?.ref ||
        state.branches.find((b) => b.name !== state.branch)?.ref ||
        state.branches[0]?.ref ||
        null;
      if (!base || !state.branches.some((b) => b.ref === base))
        throw new GitError(409, 'Branch di confronto non disponibile. Scegli un branch esistente.');
      if (!state.head)
        throw new GitError(409, 'Crea il primo commit prima di confrontare i branch.');
      try {
        comparison = await this.git.command(cwd, ['merge-base', state.head, base]);
      } catch {
        throw new GitError(
          409,
          'I branch non hanno un antenato comune. Scegli un altro riferimento.',
        );
      }
    }
    const names = await this.git.command(cwd, [
      'diff',
      ...options,
      '--name-status',
      '-z',
      comparison,
      '--',
    ]);
    const parts = names.split('\0');
    const files: DiffFile[] = [];
    for (let i = 0; i < parts.length && parts[i];) {
      const status = parts[i++];
      const first = parts[i++];
      if (status[0] === 'R' || status[0] === 'C')
        files.push({ path: parts[i++], previousPath: first, status: status[0] });
      else files.push({ path: first, status: status[0] });
    }
    // A staged edit can be undone only in the working tree. The net diff against
    // HEAD is then empty, but the next commit would still include that edit.
    if (mode === 'local') {
      const staged = (
        await this.git.command(cwd, [
          'diff',
          ...options,
          '--cached',
          '--no-renames',
          '--name-status',
          '-z',
          comparison,
          '--',
        ])
      ).split('\0');
      for (let i = 0; i < staged.length && staged[i]; i += 2) {
        if (!files.some((f) => f.path === staged[i + 1] || f.previousPath === staged[i + 1]))
          files.push({ path: staged[i + 1], status: staged[i][0], indexOnly: true });
      }
    }
    const untracked = await this.git.command(cwd, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    for (const file of untracked.split('\0').filter(Boolean))
      if (!files.some((f) => f.path === file))
        files.push({ path: file, status: 'A', untracked: true });
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      ...empty,
      base,
      comparison,
      files: files.slice(0, 500),
      total: files.length,
      limited: files.length > 500,
    };
  }

  async file(chat: Conversation, view: DiffView, requested: string): Promise<FileDiff> {
    const entry = view.files.find((f) => f.path === requested);
    if (!entry || !view.comparison)
      throw new GitError(404, 'File non presente nel confronto. Aggiorna le modifiche.');
    const cwd = chat.workspace!;
    let patch: string;
    if (entry.untracked) {
      const filename = path.resolve(cwd, entry.path);
      const root = await realpath(cwd);
      const parent = await realpath(path.dirname(filename));
      if (parent !== root && !parent.startsWith(root + path.sep))
        throw new GitError(400, 'Percorso non valido.');
      const stat = await lstat(filename);
      if (stat.size > MAX_FILE)
        return {
          patch: '',
          binary: false,
          limited: true,
          note: 'File oltre 1 MB: anteprima non disponibile.',
        };
      let bytes: Buffer;
      if (stat.isSymbolicLink()) bytes = Buffer.from(await readlink(filename));
      else if (stat.isFile()) {
        // O_NOFOLLOW prevents replacing the leaf with an external symlink during a read.
        const handle = await open(
          filename,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          if (!(await handle.stat()).isFile())
            throw new GitError(409, 'Il tipo del file è cambiato. Aggiorna le modifiche.');
          const actual = await realpath(
            process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : filename,
          );
          if (!actual.startsWith(root + path.sep)) throw new GitError(400, 'Percorso non valido.');
          const buffer = Buffer.alloc(MAX_FILE + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > MAX_FILE)
            return {
              patch: '',
              binary: false,
              limited: true,
              note: 'File oltre 1 MB: anteprima non disponibile.',
            };
          bytes = buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      } else
        return {
          patch: '',
          binary: false,
          limited: false,
          note: 'Anteprima non disponibile per questo tipo di file.',
        };
      if (bytes.includes(0)) return { patch: '', binary: true, limited: false };
      const text = bytes.toString('utf8');
      const lines = text ? text.replace(/\n$/, '').split('\n') : [];
      patch =
        `--- /dev/null\n+++ ${JSON.stringify(entry.path)}\n@@ -0,0 +1,${lines.length} @@\n` +
        lines.map((line) => '+' + line).join('\n');
      if (text && !text.endsWith('\n')) patch += '\n\\ No newline at end of file';
    } else {
      patch = await this.git.command(
        cwd,
        [
          'diff',
          ...options,
          '--unified=3',
          ...(entry.indexOnly ? ['--cached'] : []),
          view.comparison,
          '--',
          ...(entry.previousPath ? [entry.previousPath] : []),
          entry.path,
        ],
        undefined,
        true,
      );
    }
    const binary = /^Binary files .* differ$/m.test(patch);
    const lines = patch.slice(0, MAX_PATCH).split('\n');
    const limited = patch.length > MAX_PATCH || lines.length > 5000;
    return {
      patch: lines.slice(0, 5000).join('\n'),
      binary,
      limited,
      ...(entry.indexOnly
        ? {
            note: 'Modifiche preparate per il commit. La copia di lavoro le annulla: il confronto complessivo con l’ultimo commit è vuoto.',
          }
        : !patch
          ? { note: 'Il file non presenta più differenze. Aggiorna l’elenco.' }
          : {}),
    };
  }
}
