import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { commandFor } from '../server/runner';
import { McpService } from '../server/mcp';

// A real HTTP OAuth/MCP provider: checks registration, exact redirect URI, PKCE,
// code reuse, token refresh, MCP sessions, and both JSON and SSE responses.
async function provider() {
  let base = '',
    rejectAutomatic = false,
    rejectToken = false,
    refreshCount = 0;
  const clients = new Map<string, string[]>(),
    codes = new Map<string, URLSearchParams>(),
    tokens = new Set<string>();
  const calls: { auth?: string; cookie?: string; method: string; session?: string }[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname.includes('oauth-protected-resource'))
      return json({ resource: base + '/mcp', authorization_servers: [base] });
    if (url.pathname.includes('oauth-authorization-server'))
      return json({
        issuer: base,
        authorization_endpoint: base + '/authorize',
        token_endpoint: base + '/token',
        registration_endpoint: base + '/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/register') {
      const metadata = JSON.parse(body);
      if (rejectAutomatic && !metadata.redirect_uris[0].startsWith('http://localhost:4319/'))
        return json({ error: 'invalid_redirect_uri' }, 400);
      const id = randomUUID();
      clients.set(id, metadata.redirect_uris);
      return json({ ...metadata, client_id: id }, 201);
    }
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      if (!clients.get(p.get('client_id')!)?.includes(p.get('redirect_uri')!))
        return json({ error: 'invalid_redirect_uri' }, 400);
      const code = randomUUID();
      codes.set(code, p);
      const redirect = new URL(p.get('redirect_uri')!);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', p.get('state')!);
      res.writeHead(302, { Location: redirect.href });
      return res.end();
    }
    if (url.pathname === '/token') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'refresh_token') {
        refreshCount++;
        rejectToken = false;
      } else {
        const c = codes.get(p.get('code')!);
        if (
          !c ||
          c.get('client_id') !== p.get('client_id') ||
          c.get('redirect_uri') !== p.get('redirect_uri') ||
          c.get('code_challenge') !==
            createHash('sha256')
              .update(p.get('code_verifier') || '')
              .digest('base64url')
        )
          return json({ error: 'invalid_grant' }, 400);
        codes.delete(p.get('code')!);
      }
      const token = randomUUID();
      tokens.add(token);
      return json({
        access_token: token,
        token_type: 'Bearer',
        refresh_token: 'fixture-refresh',
        expires_in: 3600,
      });
    }
    if (url.pathname === '/mcp') {
      if (rejectToken || !tokens.has(req.headers.authorization?.slice(7) || '')) {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        });
        return res.end();
      }
      if (req.method === 'DELETE') {
        res.writeHead(204);
        return res.end();
      }
      const msg = JSON.parse(body);
      calls.push({
        auth: req.headers.authorization,
        cookie: req.headers.cookie,
        method: msg.method,
        session: req.headers['mcp-session-id'] as string,
      });
      if (msg.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'fixture-session');
        return json({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1.0.0' },
          },
        });
      }
      if (msg.method === 'tools/list')
        return json({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
          },
        });
      if (msg.method === 'tools/call') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'fixture tool worked' }] } })}\n\n`,
        );
      }
      res.writeHead(202);
      return res.end();
    }
    return json({}, 404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    base,
    calls,
    rejectAutomatic: () => {
      rejectAutomatic = true;
    },
    rejectToken: () => {
      rejectToken = true;
    },
    refreshCount: () => refreshCount,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('MCP: automatic callback, manual fallback, global sharing, refresh and persistent credentials', async () => {
  const upstream = await provider();
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-mcp-'));
  const config = {
    ...readConfig(),
    demo: true,
    dataDir: dir,
    password: 'fixture-password-at-least-24',
    audioKey: '',
    vapidPublic: '',
    vapidPrivate: '',
  };
  let runtime = createApp(config),
    server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  config.port = (server.address() as any).port;
  config.origin = `http://127.0.0.1:${config.port}`;
  let cookie = '';
  const request = (endpoint: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(config.origin + '/api' + endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie,
        Connection: 'close',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const authorize = async (url: string) =>
    (await fetch(url, { redirect: 'manual' })).headers.get('location')!;
  try {
    const login = await request('/login', { password: config.password });
    cookie = login.headers.get('set-cookie')!.split(';')[0];
    const chat = (await (await request('/conversations', { agent: 'claude' })).json()) as any;
    const other = (await (await request('/conversations', { agent: 'codex' })).json()) as any;
    const endpoint = '/mcp';
    assert.equal((await request(endpoint, { name: 'bad', url: 'file:///etc/passwd' })).status, 400);
    assert.equal(
      (await request(endpoint, { name: 'bad', url: 'https://user:secret@example.org/mcp' })).status,
      400,
    );
    assert.equal((await fetch(config.origin + '/api' + endpoint)).status, 401);
    const requester = runtime.mcp.access(chat.id);
    const requested = await request(
      '/mcp/agent',
      { action: 'add', name: 'fixture', url: upstream.base + '/mcp' },
      { Authorization: `Bearer ${requester.env.PA_MCP_REQUEST_TOKEN}` },
    );
    assert.equal(requested.status, 200);
    assert.doesNotMatch(await requested.text(), /authorizationUrl|code_verifier|client_secret/);
    requester.release();
    let c = ((await (await request(endpoint)).json()) as any[])[0];
    assert.equal(c.status, 'authorization_required');
    assert.equal(
      new URL(c.authorizationUrl).searchParams.get('redirect_uri'),
      config.origin + '/api/mcp/callback',
    );
    assert.equal(c.secret, undefined);
    assert.equal(c.tokens, undefined);
    const redirect = await authorize(c.authorizationUrl);
    const tampered = new URL(redirect);
    tampered.searchParams.set('state', 'wrong');
    assert.equal((await fetch(tampered)).status, 400);
    assert.equal((await request(`/mcp/${randomUUID()}/complete`, { url: redirect })).status, 400);
    const wrongOrigin = new URL(redirect);
    wrongOrigin.hostname = 'evil.example';
    assert.equal(
      (await request(`${endpoint}/${c.id}/complete`, { url: wrongOrigin.href })).status,
      400,
    );
    // Safari's callback has no app session cookie. State + PKCE are sufficient.
    const callback = await fetch(redirect);
    assert.equal(callback.status, 200);
    assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await callback.text(), /Collegamento completato/);
    assert.equal((await fetch(redirect)).status, 400, 'OAuth code/state cannot be replayed');
    c = ((await (await request(endpoint)).json()) as any[])[0];
    assert.equal(c.status, 'connected');
    assert.equal(c.authorizationUrl, undefined);
    const access = runtime.mcp.access(chat.id),
      isolated = runtime.mcp.access(other.id);
    assert.equal(access.servers.length, 1);
    assert.deepEqual(isolated.servers, access.servers);
    assert.deepEqual(
      await (await request(`/conversations/${other.id}/mcp`)).json(),
      await (await request(endpoint)).json(),
    );
    isolated.release();
    const gateway = access.servers[0].url,
      bearer = access.env[access.servers[0].tokenVariable]!;
    assert.equal((await fetch(gateway)).status, 401);
    async function tool(method: string) {
      return fetch(gateway, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          Cookie: cookie,
          Connection: 'close',
          'Mcp-Session-Id': 'fixture-session',
          'MCP-Protocol-Version': '2025-03-26',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params: {} }),
      });
    }
    const tools = await tool('tools/list');
    assert.equal(tools.status, 200);
    assert.match(await tools.text(), /echo/);
    upstream.rejectToken();
    const result = await tool('tools/call');
    assert.equal(result.status, 200);
    assert.match(await result.text(), /fixture tool worked/);
    assert.equal(upstream.refreshCount(), 1);
    assert.ok(upstream.calls.every((call) => call.auth !== `Bearer ${bearer}` && !call.cookie));
    assert.equal(upstream.calls.at(-1)!.session, 'fixture-session');
    const agentHeaders = { Authorization: `Bearer ${access.env.PA_MCP_REQUEST_TOKEN}` };
    const list = await request('/mcp/agent', { action: 'list' }, agentHeaders);
    assert.equal(list.status, 200);
    assert.doesNotMatch(await list.text(), /access_token|authorizationUrl|secret|fixture-refresh/);
    access.release();
    assert.equal((await request('/mcp/agent', { action: 'list' }, agentHeaders)).status, 401);
    const file = path.join(dir, 'mcp', 'connections.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(await readFile(file, 'utf8'), /fixture-refresh/);
    const events = JSON.stringify(runtime.store.db.prepare('SELECT data FROM events').all());
    assert.doesNotMatch(events, /fixture-refresh|code_verifier|authorizationUrl|access_token/);
    // Both CLIs get only a gateway and environment variable references, never upstream tokens.
    for (const agent of ['claude', 'codex'] as const) {
      const command = commandFor(config, { ...chat, agent }, access.servers);
      assert.ok(command.args.join(' ').includes(access.servers[0].tokenVariable));
      assert.ok(!command.args.join(' ').includes(bearer));
    }
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
    runtime = createApp(config);
    server = runtime.app.listen(config.port, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    assert.equal(((await (await request(endpoint)).json()) as any[])[0].status, 'connected');
    upstream.rejectAutomatic();
    let manual = (await (
      await request(endpoint, { name: 'manual', url: upstream.base + '/mcp' })
    ).json()) as any;
    assert.equal(manual.status, 'error');
    manual = (await (
      await request(`${endpoint}/${manual.id}/login`, { mode: 'manual' })
    ).json()) as any;
    assert.equal(manual.status, 'authorization_required');
    assert.equal(
      new URL(manual.authorizationUrl).searchParams.get('redirect_uri'),
      'http://localhost:4319/callback',
    );
    const pasted = await authorize(manual.authorizationUrl);
    const completed = await request(`${endpoint}/${manual.id}/complete`, { url: pasted });
    assert.equal(completed.status, 200);
    assert.equal(((await completed.json()) as any).status, 'connected');
    assert.equal((await request(`${endpoint}/${manual.id}/complete`, { url: pasted })).status, 400);
    let expired = (await (
      await request(endpoint, { name: 'expired', url: upstream.base + '/mcp' })
    ).json()) as any;
    expired = (await (
      await request(`${endpoint}/${expired.id}/login`, { mode: 'manual' })
    ).json()) as any;
    const expiredRedirect = await authorize(expired.authorizationUrl);
    const originalNow = Date.now,
      future = Date.now() + 11 * 60000;
    try {
      Date.now = () => future;
      assert.equal(
        (await request(`${endpoint}/${expired.id}/complete`, { url: expiredRedirect })).status,
        400,
      );
      const views = (await (await request(endpoint)).json()) as any[];
      assert.equal(views.find((v) => v.id === expired.id).status, 'error');
      assert.equal(views.find((v) => v.id === expired.id).authorizationUrl, undefined);
    } finally {
      Date.now = originalNow;
    }

    assert.equal((await request(`${endpoint}/${c.id}/delete`, {})).status, 200);
    assert.equal(
      (await fetch(gateway, { headers: { Authorization: `Bearer ${bearer}` } })).status,
      404,
    );
    assert.equal((await request(`/conversations/${chat.id}/delete`, {})).status, 200);
    assert.ok(
      runtime.mcp.list().some((c) => c.id === manual.id),
      'deleting a chat preserves global MCPs',
    );
    assert.equal(runtime.mcp.access(other.id).servers.length, 1);
  } finally {
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy chat MCPs migrate globally without losing tokens, pending logins or colliding names', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-mcp-migration-'));
  const file = path.join(dir, 'mcp', 'connections.json');
  await mkdir(path.dirname(file));
  const entries = ['notion', 'notion', 'notion-2'].map((name, i) => ({
    id: randomUUID(),
    name,
    url: 'https://example.org/mcp',
    conversationId: `old-chat-${i}`,
    mode: 'automatic',
    status: i === 2 ? 'authorization_required' : 'connected',
    secret: `gateway-fixture-${i}`,
    tokens: { access_token: `fixture-token-${i}`, token_type: 'Bearer' },
    ...(i === 2
      ? {
          pending: {
            state: 'fixture-state',
            verifier: 'fixture-verifier',
            expiresAt: Date.now() + 60000,
            redirectUrl: 'https://app.example/api/mcp/callback',
            url: 'https://example.org/authorize?state=fixture-state',
          },
        }
      : {}),
  }));
  await writeFile(file, JSON.stringify(entries));
  let mcp = new McpService({ ...readConfig(), dataDir: dir }, () => {});
  try {
    const views = mcp.list();
    assert.equal(views.length, 3);
    assert.equal(new Set(views.map((v) => v.name)).size, 3);
    assert.equal(views[1].name, 'notion-3');
    assert.deepEqual(mcp.access('new-claude').servers, mcp.access('new-codex').servers);
    assert.equal(mcp.access('unrelated-chat').servers.length, 2);
    const migrated = JSON.parse(await readFile(file, 'utf8'));
    for (let i = 0; i < entries.length; i++) {
      assert.equal(migrated[i].id, entries[i].id);
      assert.deepEqual(migrated[i].tokens, entries[i].tokens);
      assert.equal(migrated[i].conversationId, undefined);
      assert.equal(migrated[i].returnToChat, entries[i].conversationId);
    }
    assert.deepEqual(migrated[2].pending, entries[2].pending);
    mcp.close();
    mcp = new McpService({ ...readConfig(), dataDir: dir }, () => {});
    assert.deepEqual(mcp.list(), views, 'migration is stable on subsequent restarts');
    mcp.remove(entries[0].id);
    assert.equal(mcp.access('another-chat').servers.length, 1);
  } finally {
    mcp.close();
    await rm(dir, { recursive: true, force: true });
  }
});
