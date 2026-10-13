import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from './config';
import { agentEnvironment } from './runner';
import { codexRpc } from './codex-rpc';

const exec = promisify(execFile);
export interface AgentAccount {
  agent: 'claude' | 'codex';
  status: 'connected' | 'signed_out' | 'unavailable' | 'demo';
  email: string | null;
  plan: string | null;
  method: string | null;
  organization: string | null;
}
export interface AgentAccounts {
  accounts: AgentAccount[];
  checkedAt: string;
}
const label = (value: unknown) =>
  typeof value === 'string'
    ? value
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim()
        .slice(0, 320) || null
    : null;
const empty = (agent: AgentAccount['agent'], status: AgentAccount['status']): AgentAccount => ({
  agent,
  status,
  email: null,
  plan: null,
  method: null,
  organization: null,
});

// Expose only display fields, never raw CLI output, credentials or diagnostics.
export function claudeAccount(value: any): AgentAccount {
  if (typeof value?.loggedIn !== 'boolean') return empty('claude', 'unavailable');
  if (!value.loggedIn) return empty('claude', 'signed_out');
  const methods: Record<string, string> = {
    'claude.ai': 'Claude.ai',
    oauth_token: 'Token OAuth',
    api_key: 'Chiave API',
    api_key_helper: 'Helper API',
    third_party: 'Provider esterno',
  };
  return {
    ...empty('claude', 'connected'),
    email: label(value.email),
    plan: label(value.subscriptionType),
    method: Object.hasOwn(methods, value.authMethod) ? methods[value.authMethod] : null,
    organization: label(value.orgName),
  };
}
export function codexAccount(value: any): AgentAccount {
  if (value?.account === null) return empty('codex', 'signed_out');
  const account = value?.account;
  if (account?.type === 'apiKey') return { ...empty('codex', 'connected'), method: 'Chiave API' };
  if (account?.type === 'amazonBedrock')
    return { ...empty('codex', 'connected'), method: 'Amazon Bedrock' };
  if (account?.type !== 'chatgpt') return empty('codex', 'unavailable');
  return {
    ...empty('codex', 'connected'),
    email: label(account.email),
    method: 'ChatGPT',
    plan: account.planType === 'unknown' ? null : label(account.planType),
  };
}

export class AgentAccountService {
  private controller = new AbortController();
  private pending?: Promise<AgentAccounts>;
  constructor(private config: Config) {}

  read(): Promise<AgentAccounts> {
    this.controller.signal.throwIfAborted();
    // Concurrent clients share a probe; each later refresh reads the current login.
    return (this.pending ??= this.probe().finally(() => {
      this.pending = undefined;
    }));
  }
  private async probe(): Promise<AgentAccounts> {
    const accounts = this.config.demo
      ? [empty('claude', 'demo'), empty('codex', 'demo')]
      : await Promise.all([this.claude(), this.codex()]);
    return { accounts, checkedAt: new Date().toISOString() };
  }
  private async claude(): Promise<AgentAccount> {
    try {
      const options = {
        cwd: this.config.dataDir,
        env: agentEnvironment(this.config),
        timeout: 10000,
        killSignal: 'SIGKILL' as const,
        maxBuffer: 128 * 1024,
        signal: this.controller.signal,
      };
      let stdout: string;
      try {
        ({ stdout } = await exec(this.config.claudeBin, ['auth', 'status', '--json'], options));
      } catch (error) {
        // Claude documents exit 1 for signed-out status, still with JSON on stdout.
        const result = error as { code?: unknown; stdout?: string };
        if (result.code !== 1 || !result.stdout) throw error;
        const value = JSON.parse(result.stdout);
        return value?.loggedIn === false
          ? empty('claude', 'signed_out')
          : empty('claude', 'unavailable');
      }
      return claudeAccount(JSON.parse(stdout));
    } catch {
      return empty('claude', 'unavailable');
    }
  }
  private async codex(): Promise<AgentAccount> {
    try {
      const rpc = codexRpc(
        this.config.codexBin,
        ['app-server', '--listen', 'stdio://'],
        this.config.dataDir,
        agentEnvironment(this.config),
        AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]),
        () => {},
      );
      try {
        await rpc.request('initialize', {
          clientInfo: { name: 'personal_agent_accounts', version: '0.1.0' },
          capabilities: {},
        });
        rpc.notify('initialized');
        return codexAccount(await rpc.request('account/read', { refreshToken: false }));
      } finally {
        await rpc.close();
      }
    } catch {
      return empty('codex', 'unavailable');
    }
  }
  async close() {
    this.controller.abort();
    await this.pending;
  }
}
