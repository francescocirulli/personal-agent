import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexSessionModel } from '../server/session-model';
import { normalize } from '../server/protocol';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';

test('Codex metadata is scoped to the exact thread, fresh, validated and read-only', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'pa-session-model-'));
  try {
    assert.equal(await codexSessionModel('session', undefined, home), null);
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT, updated_at INTEGER)');
    const now = Date.now();
    const insert = db.prepare('INSERT INTO threads VALUES (?,?,?)');
    insert.run('session', 'model-one', Math.floor(now / 1000));
    insert.run('other', 'private-other-model', Math.floor(now / 1000));
    assert.equal(await codexSessionModel('session', now, home), 'model-one');
    assert.equal(await codexSessionModel('session', now + 2000, home), null);
    assert.equal(await codexSessionModel("session' OR 1=1--", undefined, home), null);
    db.prepare('UPDATE threads SET model=? WHERE id=?').run('model-two', 'session');
    assert.equal(await codexSessionModel('session', now, home), 'model-two');
    db.prepare('UPDATE threads SET model=? WHERE id=?').run('secret\ninvalid', 'session');
    assert.equal(await codexSessionModel('session', now, home), null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM threads').get()!.n, 2);
    db.close();
    const newer = new DatabaseSync(path.join(home, 'state_6.sqlite'));
    newer.exec('CREATE TABLE threads (id TEXT)');
    newer.close();
    assert.equal(await codexSessionModel('other', undefined, home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Claude reports init and assistant model changes but excludes subagents and synthetic output', () => {
  assert.deepEqual(
    normalize('claude', {
      type: 'system',
      subtype: 'init',
      session_id: 'session',
      model: 'claude-model-one',
    }),
    [
      { type: 'session', value: 'session' },
      { type: 'model', value: 'claude-model-one' },
    ],
  );
  assert.deepEqual(
    normalize('claude', {
      type: 'assistant',
      message: { model: 'claude-model-two', content: [] },
    }),
    [{ type: 'model', value: 'claude-model-two' }],
  );
  for (const model of ['<synthetic>', 'secret\ninvalid', undefined])
    assert.deepEqual(
      normalize('claude', { type: 'assistant', message: { model, content: [] } }),
      [],
    );
  assert.deepEqual(
    normalize('claude', {
      type: 'assistant',
      parent_tool_use_id: 'child',
      message: { model: 'child-model', content: [] },
    }),
    [],
  );
});

test('observed model survives restart, stays separate from selection and is invalidated with the session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-observed-model-'));
  const config = {
    ...readConfig(),
    dataDir: dir,
    demo: true,
    password: '',
    vapidPublic: '',
    vapidPrivate: '',
  };
  let runtime = createApp(config);
  const chat = runtime.store.create('claude', null, 'Models');
  const run = runtime.store.enqueue(chat.id, 'Example', []);
  runtime.store.db.prepare('UPDATE runs SET status=? WHERE id=?').run('complete', run);
  runtime.store.db
    .prepare('UPDATE conversations SET session_id=? WHERE id=?')
    .run('session', chat.id);
  runtime.store.db
    .prepare('INSERT INTO run_models VALUES (?,?,?)')
    .run(run, 'claude-observed', 'session');
  await runtime.close();
  runtime = createApp(config);
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  config.port = (server.address() as { port: number }).port;
  config.origin = `http://127.0.0.1:${config.port}`;
  const detail = async () => (await fetch(`${config.origin}/api/conversations/${chat.id}`)).json();
  try {
    assert.deepEqual((await detail()).actualModel, { id: 'claude-observed', state: 'last' });
    runtime.store.db
      .prepare('UPDATE conversations SET model=? WHERE id=?')
      .run('next-choice', chat.id);
    assert.equal((await detail()).actualModel.id, 'claude-observed');
    const next = runtime.store.enqueue(chat.id, 'Next', []);
    // Queued turns do not erase the last observed model.
    assert.equal((await detail()).actualModel.id, 'claude-observed');
    runtime.store.db.prepare('UPDATE runs SET status=? WHERE id=?').run('running', next);
    assert.equal((await detail()).actualModel, null);
    assert.equal((await detail()).modelPending, true);
    runtime.store.db
      .prepare('INSERT INTO run_models VALUES (?,?,?)')
      .run(next, 'resolved-next', 'session');
    assert.deepEqual((await detail()).actualModel, { id: 'resolved-next', state: 'running' });
    runtime.store.db.prepare('UPDATE conversations SET session_id=NULL WHERE id=?').run(chat.id);
    assert.equal((await detail()).actualModel, null);
  } finally {
    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
