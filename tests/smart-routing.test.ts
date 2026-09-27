import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { routeTurn, validateRouting, type RoutingDependencies } from '../server/smart-routing';
import { routingSchema, type RoutingConfig } from '../server/experiments';
import { agentModels, type AgentCatalog } from '../server/agent-models';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { Store } from '../server/store';

const catalog: AgentCatalog = {
  models: [
    {
      id: 'gpt-test-small',
      name: 'Small',
      description: 'Simple work',
      efforts: ['low', 'medium'],
      modalities: ['text', 'image'],
      contextWindow: 100000,
    },
    {
      id: 'gpt-test-large',
      name: 'Large',
      description: 'Difficult work',
      efforts: ['medium', 'high'],
      modalities: ['text', 'image'],
      contextWindow: 100000,
    },
  ],
  source: 'Test fixture',
  fetchedAt: '2026-09-27T00:00:00Z',
};
const routing: RoutingConfig = {
  enabled: true,
  preference: 'balanced',
  candidates: [
    { model: 'gpt-test-small', effort: 'low' },
    { model: 'gpt-test-large', effort: 'high' },
  ],
  fallback: { model: 'gpt-test-large', effort: 'high' },
};
const input = () => ({
  config: routing,
  catalog,
  key: 'fixture-routing-key',
  enabled: true,
  demo: false,
  signal: new AbortController().signal,
  prompt: 'Fix the typo',
  history: [],
  hasAttachments: false,
  resumed: false,
});
function decision(choice = 'route_0', confidence = 0.99) {
  return {
    id: 'test-decision',
    model: 'typesafe/jev-1.13-test',
    answers: {
      route: {
        type: 'choice',
        choice,
        confidence,
        probabilities: {
          route_0: choice === 'route_0' ? 0.99 : 0.01,
          route_1: choice === 'route_1' ? 0.99 : 0.01,
        },
      },
    },
    usage: { cost: 0.0001, input_tokens: 1000 },
  };
}
const response = (data: unknown = decision()) => (async () => Response.json(data)) as typeof fetch;

test('JEV request is bounded, selects a valid joint pair, and records cost without prompt text', async () => {
  const value = await routeTurn(
    {
      ...input(),
      prompt: 'x'.repeat(9000),
      history: Array.from({ length: 20 }, () => ({ role: 'user', text: 'y'.repeat(10000) })),
    },
    {
      fetch: (async (url, init) => {
        assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
        assert.equal(init?.redirect, 'error');
        const body = JSON.parse(String(init?.body));
        assert.ok(Buffer.byteLength(String(init?.body)) < 28000);
        assert.equal(body.model, 'typesafe/jev-1.13');
        assert.equal(body.state.recent_messages.length, 6);
        assert.equal(body.questions.route.type, 'choice');
        assert.equal(body.questions.route.criteria.route_0.model, 'gpt-test-small');
        return Response.json(decision());
      }) as typeof fetch,
    },
  );
  assert.deepEqual(value.selected, routing.candidates[0]);
  assert.equal(value.source, 'jev');
  assert.equal(value.cost, 0.0001);
  assert.equal(value.decisionModel, 'typesafe/jev-1.13-test');
  assert.ok(!JSON.stringify(value).includes('xxxxx'));
});

test('same-vendor and per-model effort restrictions reject invalid configuration', () => {
  assert.throws(() =>
    routingSchema.parse({ ...routing, fallback: { model: 'claude-opus', effort: 'high' } }),
  );
  assert.throws(() =>
    validateRouting(
      { ...routing, candidates: [{ model: 'gpt-test-small', effort: 'ultra' }] },
      catalog,
    ),
  );
  assert.throws(() =>
    validateRouting(
      { ...routing, fallback: { model: 'gpt-nonexistent', effort: 'high' } },
      catalog,
    ),
  );
  assert.throws(() =>
    routingSchema.parse({ ...routing, candidates: [routing.candidates[0], routing.candidates[0]] }),
  );
});

test('disabled, unconfigured, demo, attachment and missing catalog paths do not call JEV', async () => {
  const cases: [Partial<Parameters<typeof routeTurn>[0]>, string][] = [
    [{ enabled: false }, 'disabled'],
    [{ key: '' }, 'unconfigured'],
    [{ demo: true }, 'demo'],
    [{ hasAttachments: true }, 'attachments'],
    [{ catalog: { ...catalog, models: [] } }, 'catalog'],
    [{ prompt: 'x'.repeat(10000) }, 'context'],
  ];
  for (const [override, reason] of cases) {
    const value = await routeTurn(
      { ...input(), ...override },
      {
        fetch: (() => {
          throw new Error('Must not call');
        }) as typeof fetch,
      },
    );
    assert.equal(value.reason, reason);
    assert.deepEqual(value.selected, routing.fallback);
  }
});

test('bad decisions, HTTP failures, uncertainty, and oversized responses use explicit fallback', async () => {
  const badProbability = decision();
  badProbability.answers.route.probabilities.route_0 = 2;
  const cases: [typeof fetch, string][] = [
    [response({}), 'unavailable'],
    [response(decision('foreign-model')), 'unavailable'],
    [response(badProbability), 'unavailable'],
    [response(decision('route_0', 0.4)), 'uncertain'],
    [(async () => new Response('x'.repeat(70000))) as typeof fetch, 'unavailable'],
    ...[401, 402, 429, 500].map(
      (status) =>
        [
          (async () => new Response('secret upstream body', { status })) as typeof fetch,
          'unavailable',
        ] as [typeof fetch, string],
    ),
  ];
  for (const [fetch, reason] of cases) {
    const value = await routeTurn(input(), { fetch });
    assert.equal(value.reason, reason);
    assert.deepEqual(value.selected, routing.fallback);
    assert.ok(!JSON.stringify(value).includes('secret upstream'));
  }
});

test('timeout falls back but user cancellation propagates', async () => {
  const slow = (async (_url, init) => {
    await delay(10000, undefined, { signal: init!.signal! });
    return Response.json(decision());
  }) as typeof fetch;
  assert.equal((await routeTurn(input(), { fetch: slow, timeoutMs: 20 })).reason, 'timeout');
  const controller = new AbortController();
  const pending = routeTurn({ ...input(), signal: controller.signal }, { fetch: slow });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('continuity needs stronger evidence to change models; resume excludes smaller context windows', async () => {
  const value = await routeTurn(
    { ...input(), resumed: true },
    { fetch: response(decision('route_0', 0.8)) },
  );
  assert.equal(value.source, 'continuity');
  assert.deepEqual(value.selected, routing.fallback);
  const smaller: AgentCatalog = {
    ...catalog,
    models: catalog.models.map((model, index) => ({
      ...model,
      contextWindow: index === 0 ? 4000 : 100000,
    })),
  };
  await routeTurn(
    { ...input(), resumed: true, catalog: smaller },
    {
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(
          Object.values(body.questions.route.criteria).map((entry: any) => entry.model),
          ['gpt-test-large'],
        );
        return Response.json({
          ...decision(),
          answers: {
            route: {
              type: 'choice',
              choice: 'route_0',
              confidence: 1,
              probabilities: { route_0: 1 },
            },
          },
        });
      }) as typeof fetch,
    },
  );
});

test('catalog reads model-specific capabilities and filters hidden entries without inventing efforts', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'pa-routing-catalog-'));
  const original = process.env.AGENT_CODEX_HOME;
  process.env.AGENT_CODEX_HOME = home;
  try {
    await writeFile(
      path.join(home, 'models_cache.json'),
      JSON.stringify({
        fetched_at: catalog.fetchedAt,
        models: [
          {
            slug: 'gpt-visible',
            display_name: 'Visible',
            supported_reasoning_levels: [{ effort: 'low' }, { effort: 'unknown' }],
            input_modalities: ['text'],
            context_window: 1000,
          },
          { slug: 'gpt-legacy', display_name: 'Missing metadata' },
          { slug: 'gpt-hidden', display_name: 'Internal', visibility: 'hide' },
        ],
      }),
    );
    const result = await agentModels('codex');
    assert.deepEqual(
      result.models.map((model) => model.id),
      ['gpt-visible', 'gpt-legacy'],
    );
    assert.deepEqual(result.models[0].efforts, ['low']);
    assert.deepEqual(result.models[1].efforts, []);
    assert.equal(result.fetchedAt, catalog.fetchedAt);
  } finally {
    if (original === undefined) delete process.env.AGENT_CODEX_HOME;
    else process.env.AGENT_CODEX_HOME = original;
    await rm(home, { recursive: true, force: true });
  }
});

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'Timed out');
    await delay(20);
  }
}
async function fixture(dependencies: RoutingDependencies = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-routing-'));
  const bin = path.join(dir, 'codex.cjs'),
    log = path.join(dir, 'calls.jsonl');
  await writeFile(log, '');
  await writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'); let input = '';
process.stdin.on('data', part => input += part);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input, hasKey: !!process.env.OPENROUTER_API_KEY }) + '\\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-session' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Fixture reply' } }));
});
`,
    { mode: 0o700 },
  );
  const config = {
    ...readConfig(),
    dataDir: dir,
    demo: false,
    codexBin: bin,
    password: 'routing-test-password',
    audioKey: 'test-key',
    vapidPublic: '',
    vapidPrivate: '',
  };
  const runtime = createApp(config, {
    catalog: async () => catalog,
    fetch: response(),
    ...dependencies,
  });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  config.port = (server.address() as any).port;
  config.origin = `http://127.0.0.1:${config.port}`;
  let cookie = '';
  const request = (url: string, body?: unknown) =>
    fetch(config.origin + '/api' + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    dir,
    config,
    runtime,
    request,
    login: async () => {
      cookie = (await request('/login', { password: config.password })).headers
        .get('set-cookie')!
        .split(';')[0];
    },
    enable: () => request('/settings/experiments', { enabled: true, smartRouting: true }),
    calls: async () =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    close: async () => {
      await runtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('authenticated settings, Codex-only configuration, migration, persistence and manual override', async () => {
  const f = await fixture();
  try {
    for (const url of ['/settings/experiments', '/agents/codex/models'])
      assert.equal((await f.request(url)).status, 401);
    assert.equal(
      (await f.request('/settings/experiments', { enabled: true, smartRouting: true })).status,
      401,
    );
    await f.login();
    assert.equal(((await (await f.request('/settings/experiments')).json()) as any).enabled, false);
    assert.equal((await f.request('/conversations', { agent: 'codex', routing })).status, 409);
    await f.enable();
    assert.equal((await f.request('/conversations', { agent: 'claude', routing })).status, 400);
    assert.equal(
      (
        await f.request('/conversations', {
          agent: 'codex',
          routing: { ...routing, candidates: [{ model: 'gpt-test-small', effort: 'ultra' }] },
        })
      ).status,
      400,
    );
    const chat = (await (
      await f.request('/conversations', { agent: 'codex', routing })
    ).json()) as any;
    assert.equal(chat.model, routing.fallback.model);
    assert.equal(chat.routing.enabled, true);
    const other = f.runtime.store.create('codex', null, 'Other');
    assert.equal(other.routing, null);
    const snapshot = new Store(f.dir);
    assert.deepEqual(snapshot.conversation(chat.id)?.routing, routing);
    assert.equal((snapshot.setting('experiments') as any).enabled, true);
    snapshot.close();
    await f.request(`/conversations/${chat.id}/model`, { model: 'gpt-test-small' });
    assert.equal(f.runtime.store.conversation(chat.id)?.routing?.enabled, false);
    assert.equal(f.runtime.store.conversation(other.id)?.routing, null);
  } finally {
    await f.close();
  }
});

test('routed turns preserve CLI subscription flags, session, fallback, metadata and fork history', async () => {
  const payloads: any[] = [];
  const f = await fixture({
    fetch: (async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return Response.json(decision());
    }) as typeof fetch,
  });
  try {
    await f.login();
    await f.enable();
    const chat = (await (
      await f.request('/conversations', { agent: 'codex', routing })
    ).json()) as any;
    const first = (await (
      await f.request(`/conversations/${chat.id}/turns`, { text: 'First request' })
    ).json()) as any;
    await until(
      () =>
        f.runtime.store.runs(chat.id).find((run) => run.id === first.runId)?.status === 'complete',
    );
    const second = (await (
      await f.request(`/conversations/${chat.id}/turns`, { text: 'Follow-up' })
    ).json()) as any;
    await until(
      () =>
        f.runtime.store.runs(chat.id).find((run) => run.id === second.runId)?.status === 'complete',
    );
    const calls = await f.calls();
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.args[call.args.indexOf('--model') + 1], 'gpt-test-small');
      assert.ok(call.args.includes('model_reasoning_effort="low"'));
      assert.ok(call.args.includes('forced_login_method="chatgpt"'));
      assert.equal(call.hasKey, false);
    }
    assert.ok(calls[1].args.includes('resume'));
    assert.ok(calls[1].args.includes('fixture-session'));
    assert.equal(f.runtime.store.conversation(chat.id)?.model, 'gpt-test-large');
    assert.ok(
      payloads[1].state.recent_messages.some((message: any) => message.text === 'First request'),
    );
    const runs = f.runtime.store.runs(chat.id);
    assert.equal(runs[0].routing?.source, 'jev');
    const message = f.runtime.store
      .messages(chat.id)
      .find((message) => message.role === 'assistant')!;
    const fork = f.runtime.store.fork(chat.id, message.id);
    assert.deepEqual(fork.routing, routing);
    assert.equal(fork.session_id, null);
    assert.deepEqual(f.runtime.store.runs(fork.id)[0].routing, runs[0].routing);
    await f.request('/settings/experiments', { enabled: false, smartRouting: true });
    const third = (await (
      await f.request(`/conversations/${chat.id}/turns`, { text: 'Manual fallback' })
    ).json()) as any;
    await until(
      () =>
        f.runtime.store.runs(chat.id).find((run) => run.id === third.runId)?.status === 'complete',
    );
    assert.equal(payloads.length, 2);
    assert.equal(
      (await f.calls())[2].args[(await f.calls())[2].args.indexOf('--model') + 1],
      'gpt-test-large',
    );
    assert.equal(f.runtime.store.runs(chat.id).at(-1)?.routing?.reason, 'disabled');
  } finally {
    await f.close();
  }
});

test('disablement while JEV is pending overrides the decision; queued messages use current settings', async () => {
  let entered = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const payloads: any[] = [];
  const f = await fixture({
    fetch: (async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      entered = true;
      await gate;
      return Response.json(decision());
    }) as typeof fetch,
  });
  try {
    await f.login();
    await f.enable();
    const chat = (await (
      await f.request('/conversations', { agent: 'codex', routing })
    ).json()) as any;
    await f.request(`/conversations/${chat.id}/turns`, { text: 'Current request' });
    await until(() => entered);
    await f.request(`/conversations/${chat.id}/turns`, { text: 'FUTURE QUEUED TEXT' });
    await f.request('/settings/experiments', { enabled: true, smartRouting: false });
    release();
    await until(
      () =>
        f.runtime.store.runs(chat.id).length === 2 &&
        f.runtime.store.runs(chat.id).every((run) => run.status === 'complete'),
    );
    assert.equal(payloads.length, 1);
    assert.ok(!JSON.stringify(payloads).includes('FUTURE QUEUED TEXT'));
    for (const call of await f.calls())
      assert.equal(call.args[call.args.indexOf('--model') + 1], 'gpt-test-large');
  } finally {
    release();
    await f.close();
  }
});

test('cancellation during routing aborts JEV and never launches the CLI', async () => {
  let entered = false,
    aborted = false;
  const f = await fixture({
    fetch: (async (_url, init) => {
      entered = true;
      try {
        await delay(10000, undefined, { signal: init!.signal! });
      } catch (e) {
        aborted = true;
        throw e;
      }
      return Response.json(decision());
    }) as typeof fetch,
  });
  try {
    await f.login();
    await f.enable();
    const chat = (await (
      await f.request('/conversations', { agent: 'codex', routing })
    ).json()) as any;
    await f.request(`/conversations/${chat.id}/turns`, { text: 'Cancel before execution' });
    await until(() => entered);
    await f.request(`/conversations/${chat.id}/cancel`, {});
    await until(() => f.runtime.store.runs(chat.id)[0]?.status === 'cancelled');
    assert.ok(aborted);
    assert.deepEqual(await f.calls(), []);
  } finally {
    await f.close();
  }
});

test('manual CLI default selected during a pending decision wins without a model override', async () => {
  let entered = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({
    fetch: (async () => {
      entered = true;
      await gate;
      return Response.json(decision());
    }) as typeof fetch,
  });
  try {
    await f.login();
    await f.enable();
    const chat = (await (
      await f.request('/conversations', { agent: 'codex', routing })
    ).json()) as any;
    await f.request(`/conversations/${chat.id}/turns`, { text: 'Manual override' });
    await until(() => entered);
    await f.request(`/conversations/${chat.id}/model`, { model: null });
    release();
    await until(() => f.runtime.store.runs(chat.id)[0]?.status === 'complete');
    assert.ok(!(await f.calls())[0].args.includes('--model'));
    assert.equal(f.runtime.store.runs(chat.id)[0].routing?.source, 'manual');
    assert.equal(f.runtime.store.runs(chat.id)[0].routing?.selected.model, null);
  } finally {
    release();
    await f.close();
  }
});
