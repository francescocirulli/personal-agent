import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { commandFor } from '../server/runner';
import { Store } from '../server/store';

test('per-chat model survives restart, keeps session/history, validates input and changes only future turns', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-models-'));
  const config = {
    ...readConfig(),
    dataDir: dir,
    demo: true,
    password: 'models-test-password',
    vapidPublic: '',
    vapidPrivate: '',
  };
  const runtime = createApp(config),
    server = runtime.app.listen(0, '127.0.0.1');
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
  let id = '';
  try {
    const chat = runtime.store.create('codex', null, 'Modelli');
    id = chat.id;
    assert.equal(chat.model, null);
    assert.equal(
      (await request(`/conversations/${id}/model`, { model: 'example-model' })).status,
      401,
    );
    cookie = (await request('/login', { password: config.password })).headers
      .get('set-cookie')!
      .split(';')[0];
    runtime.store.db
      .prepare('UPDATE conversations SET session_id=? WHERE id=?')
      .run('existing-session', id);
    for (const model of ['--bad', 'bad model', '', 'a\n--flag', 'x'.repeat(161), 1])
      assert.equal((await request(`/conversations/${id}/model`, { model })).status, 400);
    const snapshot = runtime.store.conversation(id)!;
    assert.equal(
      (await request(`/conversations/${id}/model`, { model: 'example-model' })).status,
      200,
    );
    assert.equal(snapshot.model, null);
    const updated = runtime.store.conversation(id)!;
    assert.equal(updated.session_id, 'existing-session');
    for (const agent of ['codex', 'claude'] as const)
      for (const session_id of [null, 'existing-session']) {
        const { args } = commandFor(config, { ...updated, agent, session_id });
        assert.equal(args[args.indexOf('--model') + 1], 'example-model');
        if (session_id) assert.ok(args.includes(session_id));
        assert.equal(
          commandFor(config, { ...updated, agent, model: null }).args.includes('--model'),
          false,
        );
      }
    const other = runtime.store.create('claude', null, 'Altra');
    assert.equal(other.model, null);
    assert.ok(
      ((await (await request(`/conversations/${other.id}/models`)).json()) as any).models.some(
        (m: any) => m.id === 'sonnet',
      ),
    );
    assert.equal((await request(`/conversations/${id}/model`, { model: null })).status, 200);
    assert.equal(runtime.store.conversation(id)!.model, null);
    await request(`/conversations/${id}/model`, { model: 'persisted-model' });
  } finally {
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
  const store = new Store(dir);
  assert.equal(store.conversation(id)!.model, 'persisted-model');
  store.close();
  await rm(dir, { recursive: true, force: true });
});
