import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import type { Config } from './config';
import { mcpAvailability } from './chat-tools';

export class McpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const mcpInput = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/),
    url: z.string().url().max(2000),
  })
  .strict();
type Mode = 'automatic' | 'manual';
type Status = 'connecting' | 'authorization_required' | 'connected' | 'error';
interface Connection {
  enabled?: boolean;
  id: string;
  // Navigation hint only: every connection is shared by all chats and both agents.
  returnToChat?: string;
  name: string;
  url: string;
  mode: Mode;
  status: Status;
  error?: string;
  secret: string;
  discovery?: OAuthDiscoveryState;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokenExpiresAt?: number;
  resourceMetadataUrl?: string;
  scope?: string;
  pending?: {
    state: string;
    verifier?: string;
    url?: string;
    expiresAt: number;
    redirectUrl: string;
  };
}
export interface McpView {
  enabled?: boolean;
  id: string;
  name: string;
  url: string;
  mode: Mode;
  status: Status;
  error?: string;
  authorizationUrl?: string;
  expiresAt?: number;
}
export interface McpAgentServer {
  name: string;
  url: string;
  tokenVariable: string;
}
export interface McpAccess {
  servers: McpAgentServer[];
  env: NodeJS.ProcessEnv;
  release(): void;
}
const secret = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'personal-agent', version: '1.0.0' },
  },
};

export class McpService {
  private connections = new Map<string, Connection>();
  private locks = new Set<string>();
  private refreshes = new Map<string, Promise<void>>();
  private runs = new Map<
    string,
    { conversationId: string; selected: string[] | null; allowed: Set<string> }
  >();
  private file: string;
  private closed = false;
  private controllers = new Set<AbortController>();
  constructor(
    private config: Config,
    private changed: () => void,
  ) {
    const dir = path.join(config.dataDir, 'mcp');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'connections.json');
    if (existsSync(this.file)) {
      const stored = JSON.parse(readFileSync(this.file, 'utf8')) as (Connection & {
        conversationId?: string;
      })[];
      const reserved = new Set(stored.map((c) => c.name));
      const used = new Set<string>();
      for (const c of stored) {
        if (c.conversationId) c.returnToChat = c.conversationId;
        delete c.conversationId;
        // Keep all accounts/tokens, even when different chats used the same name.
        if (used.has(c.name)) {
          const base = c.name.slice(0, 43);
          let suffix = 2;
          while (reserved.has(`${base}-${suffix}`)) suffix++;
          c.name = `${base}-${suffix}`;
          reserved.add(c.name);
        }
        used.add(c.name);
        if (c.status === 'connecting') {
          c.status = 'error';
          c.error = 'Collegamento interrotto dal riavvio. Riprova.';
        }
        this.connections.set(c.id, c);
      }
      this.save();
    }
  }
  private save(c?: Connection) {
    if (this.closed) return;
    writeFileSync(this.file + '.tmp', JSON.stringify([...this.connections.values()]), {
      mode: 0o600,
    });
    renameSync(this.file + '.tmp', this.file);
    if (c) this.changed();
  }
  private get(id: string) {
    const c = this.connections.get(id);
    if (!c) throw new McpError(404, 'Collegamento non trovato.');
    return c;
  }
  private view(c: Connection): McpView {
    const expired = c.pending && c.pending.expiresAt < Date.now();
    return {
      id: c.id,
      enabled: c.enabled !== false,
      name: c.name,
      url: c.url,
      mode: c.mode,
      status: expired && c.status === 'authorization_required' ? 'error' : c.status,
      error: expired ? 'Il login è scaduto. Premi Riprova.' : c.error,
      authorizationUrl: !expired ? c.pending?.url : undefined,
      expiresAt: c.pending?.expiresAt,
    };
  }
  list() {
    return [...this.connections.values()].map((c) => this.view(c));
  }
  private checkUrl(raw: string) {
    const url = new URL(raw);
    const localTest =
      this.config.demo &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((!localTest && url.protocol !== 'https:') || url.username || url.password || url.hash)
      throw new McpError(400, 'Inserisci un indirizzo MCP HTTPS senza credenziali.');
    return url;
  }
  // Bound every OAuth/discovery request and never follow a redirect carrying credentials.
  private fetch = async (
    input: string | URL | RequestInfo,
    init?: RequestInit,
  ): Promise<globalThis.Response> => {
    this.checkUrl(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      if (this.closed) controller.abort();
      return await fetch(input, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(20000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
    } finally {
      this.controllers.delete(controller);
    }
  };
  async add(input: unknown, returnToChat?: string) {
    const data = mcpInput.parse(input);
    this.checkUrl(data.url);
    const existing = [...this.connections.values()].find((c) => c.name === data.name);
    if (existing) {
      if (existing.url !== data.url)
        throw new McpError(409, 'Questo nome è già usato per un altro collegamento.');
      return this.view(existing);
    }
    if (this.list().length >= 20)
      throw new McpError(400, 'Sono già presenti 20 collegamenti nelle impostazioni.');
    const c: Connection = {
      ...data,
      id: randomUUID(),
      returnToChat,
      mode: 'automatic',
      status: 'connecting',
      secret: secret(),
    };
    this.connections.set(c.id, c);
    this.save(c);
    return this.login(c.id, 'automatic');
  }
  private begin(c: Connection) {
    c.pending = {
      state: secret(),
      expiresAt: Date.now() + 10 * 60000,
      redirectUrl:
        c.mode === 'automatic'
          ? `${this.config.origin}/api/mcp/callback`
          : 'http://localhost:4319/callback',
    };
  }
  private provider(c: Connection): OAuthClientProvider {
    const service = this;
    return {
      get redirectUrl() {
        return (
          c.pending?.redirectUrl ||
          (c.mode === 'automatic'
            ? `${service.config.origin}/api/mcp/callback`
            : 'http://localhost:4319/callback')
        );
      },
      get clientMetadata() {
        return {
          client_name: 'Personal Agent',
          redirect_uris: [String(this.redirectUrl)],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        };
      },
      state: () => {
        if (!c.pending) service.begin(c);
        return c.pending!.state;
      },
      discoveryState: () => c.discovery,
      saveDiscoveryState: (discovery) => {
        c.discovery = discovery;
        service.save();
      },
      clientInformation: () => c.client,
      saveClientInformation: (info) => {
        c.client = info;
        service.save();
      },
      tokens: () => c.tokens,
      saveTokens: (tokens) => {
        c.tokens = tokens;
        c.tokenExpiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined;
        service.save();
      },
      saveCodeVerifier: (verifier) => {
        if (!c.pending) service.begin(c);
        c.pending!.verifier = verifier;
        service.save();
      },
      codeVerifier: () => {
        if (!c.pending?.verifier) throw new McpError(400, 'Login scaduto. Riprova.');
        return c.pending.verifier;
      },
      redirectToAuthorization: (url) => {
        service.checkUrl(url.href);
        if (!c.pending) service.begin(c);
        c.pending!.url = url.href;
        c.status = 'authorization_required';
        service.save(c);
      },
      invalidateCredentials: (scope) => {
        if (scope === 'all' || scope === 'discovery') c.discovery = undefined;
        if (scope === 'all' || scope === 'client') c.client = undefined;
        if (scope === 'all' || scope === 'tokens') {
          c.tokens = undefined;
          c.tokenExpiresAt = undefined;
        }
        if (scope === 'all' || scope === 'verifier') {
          if (c.pending) c.pending.verifier = undefined;
        }
        service.save();
      },
    };
  }
  private async authorize(c: Connection, code?: string) {
    return auth(this.provider(c), {
      serverUrl: c.url,
      authorizationCode: code,
      scope: c.scope,
      resourceMetadataUrl: c.resourceMetadataUrl ? new URL(c.resourceMetadataUrl) : undefined,
      fetchFn: this.fetch,
    });
  }
  private async probe(c: Connection) {
    const res = await this.fetch(c.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(c.tokens ? { Authorization: `Bearer ${c.tokens.access_token}` } : {}),
      },
      body: JSON.stringify(initialize),
    });
    if (res.status === 401) {
      const challenge = extractWWWAuthenticateParams(res);
      c.resourceMetadataUrl = challenge.resourceMetadataUrl?.href;
      c.scope = challenge.scope;
      await res.body?.cancel();
      return false;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error('MCP initialization failed');
    }
    // Validate that this is actually MCP, not an HTML page returning 200.
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Missing MCP response');
    let data = '',
      result: any;
    const decoder = new TextDecoder();
    try {
      while (data.length < 128000) {
        const { value, done } = await reader.read();
        data += decoder.decode(value, { stream: !done });
        if (res.headers.get('content-type')?.includes('text/event-stream')) {
          for (const block of data.split(/\r?\n\r?\n/).slice(0, -1)) {
            const payload = block
              .split(/\r?\n/)
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (payload) {
              const msg = JSON.parse(payload);
              if (msg.id === 1) result = msg;
            }
          }
        } else {
          try {
            result = JSON.parse(data);
          } catch {}
        }
        if (result || done) break;
      }
    } finally {
      await reader.cancel();
    }
    if (result?.id !== 1 || !result.result?.protocolVersion || !result.result?.serverInfo)
      throw new Error('Invalid MCP initialization');
    const session = res.headers.get('mcp-session-id');
    if (session) {
      const headers = {
        'Mcp-Session-Id': session,
        'MCP-Protocol-Version': result.result.protocolVersion,
        ...(c.tokens ? { Authorization: `Bearer ${c.tokens.access_token}` } : {}),
      };
      // The probe owns its session; don't leave an unused session running upstream.
      const cleanup = await this.fetch(c.url, { method: 'DELETE', headers }).catch(() => undefined);
      await cleanup?.body?.cancel();
    }
    return true;
  }
  private connected(c: Connection) {
    c.status = 'connected';
    c.error = undefined;
    c.pending = undefined;
    this.save(c);
  }
  async login(id: string, mode: Mode) {
    const c = this.get(id);
    if (this.locks.has(id) || this.refreshes.has(id))
      throw new McpError(409, 'Collegamento già in corso.');
    this.locks.add(id);
    try {
      if (c.mode !== mode) {
        c.client = undefined;
        c.tokens = undefined;
        c.tokenExpiresAt = undefined;
      }
      c.mode = mode;
      c.pending = undefined;
      c.status = 'connecting';
      c.error = undefined;
      this.save(c);
      if (await this.probe(c)) this.connected(c);
      else {
        this.begin(c);
        const result = await this.authorize(c);
        if (result === 'AUTHORIZED') {
          if (!(await this.probe(c))) throw new Error('Authorization rejected');
          this.connected(c);
        }
      }
    } catch {
      c.status = 'error';
      c.pending = undefined;
      c.error =
        mode === 'automatic'
          ? 'Il servizio non ha completato il collegamento. Verifica l’indirizzo o prova il login con copia e incolla. Alcuni servizi richiedono un client OAuth registrato.'
          : 'Login non disponibile. Verifica che il servizio supporti OAuth e la registrazione automatica dei client.';
      this.save(c);
    } finally {
      this.locks.delete(id);
    }
    return this.view(c);
  }
  async complete(raw: string, id?: string) {
    if (raw.length > 12000) throw new McpError(400, 'Indirizzo di ritorno non valido.');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new McpError(400, 'Incolla l’indirizzo completo dalla barra del browser.');
    }
    const state = url.searchParams.get('state');
    const c = [...this.connections.values()].find(
      (c) => c.pending && state && equal(c.pending.state, state),
    );
    if (!c || (id && c.id !== id) || c.pending!.expiresAt < Date.now())
      throw new McpError(400, 'Login scaduto o relativo a un altro collegamento. Riprova.');
    const expected = new URL(c.pending!.redirectUrl);
    if (
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new McpError(400, 'L’indirizzo non corrisponde a questo login.');
    if (this.locks.has(c.id)) throw new McpError(409, 'Conferma già in corso.');
    if (url.searchParams.has('error')) {
      c.pending = undefined;
      c.status = 'error';
      c.error = 'Accesso non autorizzato. Puoi riprovare.';
      this.save(c);
      return { returnToChat: c.returnToChat, connection: this.view(c) };
    }
    const code = url.searchParams.get('code');
    if (
      !code ||
      url.searchParams.getAll('code').length !== 1 ||
      url.searchParams.getAll('state').length !== 1
    )
      throw new McpError(400, 'Nell’indirizzo manca una conferma valida.');
    this.locks.add(c.id);
    try {
      c.status = 'connecting';
      this.save(c);
      if ((await this.authorize(c, code)) !== 'AUTHORIZED' || !(await this.probe(c)))
        throw new Error('Authorization failed');
      this.connected(c);
    } catch {
      c.status = 'error';
      c.error = 'Non è stato possibile confermare l’accesso. Avvia un nuovo login.';
      c.pending = undefined;
      this.save(c);
    } finally {
      this.locks.delete(c.id);
    }
    return { returnToChat: c.returnToChat, connection: this.view(c) };
  }
  remove(id: string) {
    const c = this.get(id);
    if (this.locks.has(id) || this.refreshes.has(id))
      throw new McpError(409, 'Attendi il completamento del collegamento.');
    this.connections.delete(c.id);
    this.save(c);
  }
  setEnabled(id: string, enabled: boolean) {
    const c = this.get(id);
    c.enabled = enabled;
    this.save(c);
    return this.view(c);
  }
  access(conversationId: string, selected: string[] | null = null): McpAccess {
    const token = secret();
    const grant = { conversationId, selected, allowed: new Set<string>() };
    this.runs.set(token, grant);
    const env: NodeJS.ProcessEnv = {
      PA_MCP_REQUEST_URL: `http://127.0.0.1:${this.config.port}/api/mcp/agent`,
      PA_MCP_REQUEST_TOKEN: token,
      PA_MCP_REQUEST_SCRIPT: path.resolve('server/mcp-request.mjs'),
    };
    const servers = [...this.connections.values()]
      .filter((c) => mcpAvailability(this.view(c), selected).available)
      .map((c) => {
        const tokenVariable = `PA_MCP_${c.id.replaceAll('-', '_')}`;
        grant.allowed.add(c.id);
        env[tokenVariable] = token;
        return {
          name: `pa_${c.name}`,
          url: `http://127.0.0.1:${this.config.port}/api/mcp/gateway/${c.id}`,
          tokenVariable,
        };
      });
    return {
      servers,
      env,
      release: () => {
        this.runs.delete(token);
      },
    };
  }
  async agentRequest(bearer: string | undefined, body: unknown) {
    const grant = this.runs.get(bearer?.replace(/^Bearer /, '') || '');
    if (!grant) throw new McpError(401, 'Sessione agente non autorizzata.');
    const input = z
      .object({
        action: z.enum(['add', 'list']),
        name: z.string().optional(),
        url: z.string().optional(),
      })
      .strict()
      .parse(body);
    if (input.action === 'add')
      await this.add({ name: input.name, url: input.url }, grant.conversationId);
    // Never put OAuth URLs, codes, or credentials into agent tool output/history.
    return this.list().map(({ id, name, status, error, enabled }) => ({
      id,
      name,
      status,
      error,
      enabled,
      selectedForChat: grant.selected === null || grant.selected.includes(id),
    }));
  }
  private async refresh(c: Connection) {
    const existing = this.refreshes.get(c.id);
    if (existing) return existing;
    const task = (async () => {
      if (this.locks.has(c.id)) throw new McpError(409, 'Login in corso.');
      try {
        this.begin(c);
        if ((await this.authorize(c)) === 'AUTHORIZED') this.connected(c);
        else throw new McpError(401, 'Completa il login nella chat.');
      } catch {
        if (c.status !== 'authorization_required') {
          c.status = 'error';
          c.pending = undefined;
          c.error = 'Accesso scaduto. Accedi di nuovo.';
          this.save(c);
        }
        throw new McpError(401, 'Completa il login nella chat.');
      }
    })();
    this.refreshes.set(c.id, task);
    try {
      await task;
    } finally {
      this.refreshes.delete(c.id);
    }
  }
  async gateway(req: Request, res: Response) {
    const c = this.get(String(req.params.id));
    const provided = req.headers.authorization?.replace(/^Bearer /, '') || '';
    if (!this.runs.get(provided)?.allowed.has(c.id))
      throw new McpError(401, 'Collegamento non autorizzato.');
    if (c.enabled === false)
      throw new McpError(403, 'Collegamento disabilitato nelle impostazioni globali.');
    if (c.status !== 'connected') throw new McpError(401, 'Completa il login nella chat.');
    if (c.tokenExpiresAt && c.tokenExpiresAt < Date.now() + 30000) await this.refresh(c);
    const headers: Record<string, string> = { Accept: 'application/json, text/event-stream' };
    for (const key of ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
      const value = req.headers[key];
      if (typeof value === 'string') headers[key] = value;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const stop = () => controller.abort();
    res.on('close', stop);
    const send = () =>
      fetch(c.url, {
        method: req.method,
        headers: {
          ...headers,
          ...(c.tokens ? { Authorization: `Bearer ${c.tokens.access_token}` } : {}),
        },
        body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
        redirect: 'error',
        signal: controller.signal,
      });
    try {
      let upstream = await send();
      if (upstream.status === 401) {
        await upstream.body?.cancel();
        await this.refresh(c);
        upstream = await send();
      }
      res.status(upstream.status);
      for (const key of ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'retry-after']) {
        const value = upstream.headers.get(key);
        if (value) res.setHeader(key, value);
      }
      res.setHeader('X-Accel-Buffering', 'no');
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as any), res);
      else res.end();
    } finally {
      res.off('close', stop);
      this.controllers.delete(controller);
    }
  }
  close() {
    this.closed = true;
    this.runs.clear();
    for (const c of this.controllers) c.abort();
  }
}
