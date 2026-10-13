import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { get as httpGet } from 'node:http';
import { AgentAccountService, claudeAccount, codexAccount } from '../server/agent-accounts';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';

test('account projections allow only display fields and handle partial or unknown CLI responses', () => {
  const claude = claudeAccount({
    loggedIn: true,
    email: 'claude@example.test',
    subscriptionType: 'max',
    authMethod: 'claude.ai',
    orgName: 'Example',
    accessToken: 'secret',
    configDirectory: '/private',
  });
  assert.deepEqual(claude, {
    agent: 'claude',
    status: 'connected',
    email: 'claude@example.test',
    plan: 'max',
    method: 'Claude.ai',
    organization: 'Example',
  });
  assert.equal(claudeAccount({ loggedIn: true, authMethod: 'oauth_token' }).plan, null);
  assert.equal(claudeAccount({ loggedIn: true, authMethod: 'oauth_token' }).email, null);
  assert.equal(claudeAccount({ loggedIn: false, email: 'stale@example.test' }).email, null);
  assert.equal(claudeAccount({ loggedIn: 'true' }).status, 'unavailable');
  assert.equal(claudeAccount({ loggedIn: true, authMethod: '__proto__' }).method, null);
  assert.deepEqual(
    codexAccount({
      account: {
        type: 'chatgpt',
        email: 'codex@example.test',
        planType: 'plus',
        accessToken: 'secret',
      },
      other: 'private',
    }),
    {
      agent: 'codex',
      status: 'connected',
      email: 'codex@example.test',
      plan: 'plus',
      method: 'ChatGPT',
      organization: null,
    },
  );
  assert.equal(codexAccount({ account: null }).status, 'signed_out');
  assert.equal(codexAccount({ account: { type: 'chatgpt', planType: 'unknown' } }).plan, null);
  assert.equal(codexAccount({ account: { type: 'apiKey', key: 'secret' } }).method, 'Chiave API');
  assert.equal(codexAccount({ account: { type: 'future' } }).status, 'unavailable');
  assert.equal(codexAccount({}).status, 'unavailable');
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-accounts-'));
  const bin = path.join(dir, 'cli.cjs');
  const stateFile = path.join(dir, 'state.json');
  const log = path.join(dir, 'calls.jsonl');
  await writeFile(log, '');
  const update = (value: object) => writeFile(stateFile, JSON.stringify(value));
  await update({
    claude: {
      loggedIn: true,
      email: 'claude@example.test',
      subscriptionType: 'max',
      authMethod: 'claude.ai',
    },
    codex: { account: { type: 'chatgpt', email: 'codex@example.test', planType: 'pro' } },
  });
  await writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const log = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(value)+'\\n');
log({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.CODEX_HOME,
  leaked: !!(process.env.OPENROUTER_API_KEY || process.env.APP_PASSWORD || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) });
if (process.argv.includes('app-server')) {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const packet = JSON.parse(line); log(packet);
    if (state.hang) return;
    if (packet.method === 'initialize') console.log(JSON.stringify({ id: packet.id, result: {} }));
    if (packet.method === 'account/read') console.log(JSON.stringify({ id: packet.id, result: state.codex }));
  });
} else {
  if (state.hang) setInterval(() => {}, 1000);
  else { console.log(state.malformed ? 'private-diagnostic-secret' : JSON.stringify(state.claude)); process.exit(state.exit || 0); }
}
`,
    { mode: 0o700 },
  );
  const config = {
    ...readConfig(),
    dataDir: dir,
    demo: false,
    claudeBin: bin,
    codexBin: bin,
    password: 'account-test-password',
    vapidPublic: '',
    vapidPrivate: '',
    audioKey: '',
  };
  return { dir, log, config, update };
}

test('authenticated account endpoint uses bounded read-only CLI probes, refreshes and hides diagnostics', async () => {
  const f = await fixture();
  const runtime = createApp(f.config);
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  f.config.port = (server.address() as any).port;
  f.config.origin = `http://127.0.0.1:${f.config.port}`;
  const base = f.config.origin + '/api';
  const saved = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    APP_PASSWORD: process.env.APP_PASSWORD,
    AGENT_CODEX_HOME: process.env.AGENT_CODEX_HOME,
  };
  Object.assign(process.env, {
    OPENROUTER_API_KEY: 'fixture-audio-secret',
    APP_PASSWORD: 'fixture-password',
    AGENT_CODEX_HOME: f.dir,
  });
  try {
    assert.equal((await fetch(base + '/agent-accounts')).status, 401);
    assert.equal(await readFile(f.log, 'utf8'), '');
    const login = await fetch(base + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: f.config.password }),
    });
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0] };
    const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
      httpGet(
        base + '/agent-accounts',
        { headers: { ...headers, Host: 'untrusted.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      ).on('error', reject);
    });
    assert.equal(rejectedHost, 403);
    const response = await fetch(base + '/agent-accounts', { headers });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.deepEqual(
      data.accounts.map((a: any) => [a.email, a.plan]),
      [
        ['claude@example.test', 'max'],
        ['codex@example.test', 'pro'],
      ],
    );
    const calls = (await readFile(f.log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.filter((c) => c.method).map((c) => c.method),
      ['initialize', 'initialized', 'account/read'],
    );
    assert.deepEqual(calls.find((c) => c.method === 'account/read').params, {
      refreshToken: false,
    });
    assert.deepEqual(calls.find((c) => c.args?.[0] === 'auth').args, ['auth', 'status', '--json']);
    for (const call of calls.filter((c) => c.args)) {
      assert.equal(call.leaked, false);
      assert.equal(call.home, f.dir);
      assert.equal(call.cwd, f.dir);
    }
    await f.update({
      claude: { loggedIn: false, email: 'stale@example.test' },
      exit: 1,
      codex: { account: null },
    });
    const signedOut = await (await fetch(base + '/agent-accounts', { headers })).json();
    assert.ok(signedOut.accounts.every((a: any) => a.status === 'signed_out' && a.email === null));
    await f.update({
      malformed: true,
      codex: { account: { type: 'chatgpt', email: 'new@example.test', planType: 'plus' } },
    });
    const partial = await (await fetch(base + '/agent-accounts', { headers })).json();
    assert.equal(partial.accounts[0].status, 'unavailable');
    assert.equal(partial.accounts[1].email, 'new@example.test');
    assert.ok(!JSON.stringify(partial).includes('secret'));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('demo avoids CLI access, concurrent probes share processes, shutdown aborts hanging probes', async () => {
  const f = await fixture();
  const demo = new AgentAccountService({ ...f.config, demo: true });
  const service = new AgentAccountService(f.config);
  try {
    assert.ok((await demo.read()).accounts.every((a) => a.status === 'demo'));
    assert.equal(await readFile(f.log, 'utf8'), '');
    await f.update({ hang: true });
    const first = service.read();
    assert.equal(service.read(), first);
    await service.close();
    assert.ok((await first).accounts.every((a) => a.status === 'unavailable'));
    assert.throws(() => service.read());
  } finally {
    await demo.close();
    await service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
