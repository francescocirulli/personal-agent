import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { agentEnvironment } from './runner';

const exec = promisify(execFile);
export interface GitHubInfo {
  connected: boolean;
  login: string | null;
  repositories: { fullName: string; private: boolean }[];
  owners: { login: string; type: 'User' | 'Organization' }[];
  error?: string;
}
export class GitHubService {
  private cached?: { at: number; data: GitHubInfo };
  private pending?: Promise<GitHubInfo>;
  constructor(private demo: boolean) {}
  async info(): Promise<GitHubInfo> {
    if (this.demo)
      return {
        connected: false,
        login: null,
        repositories: [],
        owners: [],
        error: 'Repository di prova: nessun account usato in modalità dimostrazione.',
      };
    if (this.cached && Date.now() - this.cached.at < 60000) return this.cached.data;
    if (this.pending) return this.pending;
    this.pending = this.load()
      .then((data) => {
        if (data.connected) this.cached = { data, at: Date.now() };
        return data;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async load(): Promise<GitHubInfo> {
    try {
      const options = { env: agentEnvironment(), timeout: 45000, maxBuffer: 16 * 1024 * 1024 };
      const [user, repos, organizations] = await Promise.all([
        exec('gh', ['api', 'user', '--jq', '.login'], options),
        exec(
          'gh',
          [
            'api',
            '--paginate',
            'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
            '--jq',
            '.[] | {fullName: .full_name, private: .private, owner: .owner.login, ownerType: .owner.type} | tojson',
          ],
          options,
        ),
        exec(
          'gh',
          ['api', '--paginate', 'user/orgs?per_page=100', '--jq', '.[].login'],
          options,
        ).catch(() => ({ stdout: '' })),
      ]);
      const login = user.stdout.trim();
      const repositories = repos.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)) as {
        fullName: string;
        private: boolean;
        owner: string;
        ownerType: 'User' | 'Organization';
      }[];
      const owners = new Map<string, { login: string; type: 'User' | 'Organization' }>();
      owners.set(login.toLowerCase(), { login, type: 'User' });
      for (const org of organizations.stdout.split('\n').filter(Boolean))
        owners.set(org.toLowerCase(), { login: org, type: 'Organization' });
      for (const repo of repositories)
        owners.set(repo.owner.toLowerCase(), { login: repo.owner, type: repo.ownerType });
      return {
        connected: true,
        login,
        owners: [...owners.values()].sort((a, b) =>
          a.login === login ? -1 : b.login === login ? 1 : a.login.localeCompare(b.login),
        ),
        repositories: repositories.map(({ fullName, private: privateRepo }) => ({
          fullName,
          private: privateRepo,
        })),
      };
    } catch {
      return {
        connected: false,
        login: null,
        repositories: [],
        owners: [],
        error: 'GitHub non collegato o non raggiungibile. Verifica l’accesso nel container.',
      };
    }
  }
}
