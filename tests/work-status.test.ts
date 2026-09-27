import { test } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { splitVoice } from '../server/protocol';
import { Store } from '../server/store';

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(20);
  }
  assert.fail('Timed out waiting for work status');
}
test('clarifications require explicit prose marker, never a question heuristic or fenced example', () => {
  assert.equal(splitVoice('Vuoi altro?').awaitingInput, false);
  assert.equal(splitVoice('Il marcatore è `<richiesta_input/>`.').awaitingInput, false);
  assert.equal(splitVoice('~~~xml\n<richiesta_input/>\n~~~').awaitingInput, false);
  assert.equal(splitVoice('```xml\n<richiesta_input/>\n```').awaitingInput, false);
  const result = splitVoice('Quale ambiente?\n<richiesta_input/>\n<voce>Quale ambiente?</voce>');
  assert.equal(result.awaitingInput, true);
  assert.equal(result.text, 'Quale ambiente?');
  assert.equal(result.voice, 'Quale ambiente?');
});

test('clarification status persists, pauses backlog, prioritizes direct reply and preserves outcome states', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-work-status-'));
  const bin = path.join(dir, 'agent.cjs');
  await writeFile(
    bin,
    `#!/usr/bin/env node
console.log(JSON.stringify({type:'thread.started',thread_id:'status-session'}));
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>setTimeout(()=>{
const request=input.split('Richiesta dell’utente:').at(-1);
const text=request.includes('ASK_QUESTION')?'Quale ambiente?\\n<richiesta_input/>\\n<voce>Quale ambiente?</voce>':'Completato <voce>Completato.</voce>';
if(request.includes('FAIL_TASK')){console.log(JSON.stringify({type:'turn.failed'}));return;}
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
},500));`,
    { mode: 0o700 },
  );
  const config = {
    ...readConfig(),
    dataDir: dir,
    demo: false,
    codexBin: bin,
    password: '',
    maxRuns: 1,
    vapidPublic: '',
    vapidPrivate: '',
  };
  let runtime = createApp(config);
  let server = runtime.app.listen(0, '127.0.0.1');
  async function listen() {
    await new Promise<void>((r) => server.once('listening', r));
    config.port = (server.address() as any).port;
    config.origin = `http://127.0.0.1:${config.port}`;
  }
  await listen();
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(config.origin + '/api' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `${route}: ${response.status}`);
    return response.json();
  };
  try {
    const chat = await request('/conversations', { agent: 'codex', title: 'States' });
    const base = `/conversations/${chat.id}`;
    const first = await request(base + '/turns', { text: 'ASK_QUESTION' });
    const second = await request(base + '/turns', { text: 'Backlog' });
    await until(() =>
      runtime.store
        .runs(chat.id)
        .some((r) => r.id === first.runId && r.status === 'awaiting_input'),
    );
    assert.equal(runtime.store.conversation(chat.id)?.queue_paused, 1);
    assert.equal(runtime.store.list().find((c) => c.id === chat.id)?.status, 'awaiting_input');
    assert.equal(runtime.store.queue(chat.id)[0].run_id, second.runId);
    assert.doesNotMatch(runtime.store.messages(chat.id).at(-1)!.text, /richiesta_input/);
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
    runtime = createApp(config);
    server = runtime.app.listen(0, '127.0.0.1');
    await listen();
    assert.equal(runtime.store.list().find((c) => c.id === chat.id)?.status, 'awaiting_input');
    const answer = await request(base + '/turns', { text: 'Use staging' });
    await until(() =>
      runtime.store.runs(chat.id).some((r) => r.id === answer.runId && r.status === 'complete'),
    );
    assert.equal(runtime.store.queue(chat.id)[0].run_id, second.runId);
    assert.equal(runtime.store.list().find((c) => c.id === chat.id)?.status, 'queued');
    await request(base + '/queue/pause', { paused: false });
    await until(() =>
      runtime.store.runs(chat.id).every((r) => !['running', 'queued'].includes(r.status)),
    );
    assert.equal(runtime.store.list().find((c) => c.id === chat.id)?.status, 'complete');
    const failure = await request(base + '/turns', { text: 'FAIL_TASK' });
    await until(() =>
      runtime.store.runs(chat.id).some((r) => r.id === failure.runId && r.status === 'error'),
    );
    assert.equal(runtime.store.activities(chat.id).at(-1)?.kind, 'error');
    const cancelled = await request(base + '/turns', { text: 'Stop this work' });
    await request(base + '/cancel', {});
    await until(() =>
      runtime.store.runs(chat.id).some((r) => r.id === cancelled.runId && r.status === 'cancelled'),
    );
    assert.equal(runtime.store.list().find((c) => c.id === chat.id)?.status, 'cancelled');
    const shutdown = await request(base + '/turns', { text: 'Interrupted at shutdown' });
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
    runtime = createApp(config);
    server = runtime.app.listen(0, '127.0.0.1');
    await listen();
    assert.equal(
      runtime.store.runs(chat.id).find((r) => r.id === shutdown.runId)?.status,
      'interrupted',
    );
  } finally {
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('old activity rows migrate to informational events and failed/stopped states survive reload', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-status-db-'));
  let store = new Store(dir);
  try {
    const chat = store.create('codex', null, 'History');
    store.db
      .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)')
      .run('run', chat.id, 'running', null, 1, 1);
    store.activity(chat.id, 'run', 'Reading a file');
    store.db.exec('ALTER TABLE activity DROP COLUMN kind');
    store.close();
    store = new Store(dir);
    assert.equal(store.activities(chat.id)[0].kind, 'info');
    assert.equal(store.list()[0].status, 'interrupted');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a spoken clarification reply bypasses a paused backlog while respecting global capacity', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-spoken-reply-'));
  const audioServer = createServer((req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: 'Usa ambiente staging' }));
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => audioServer.once('listening', r));
  const config = {
    ...readConfig(),
    dataDir: dir,
    demo: true,
    password: '',
    maxRuns: 1,
    audioKey: 'test-audio',
    audioBase: `http://127.0.0.1:${(audioServer.address() as any).port}`,
    vapidPublic: '',
    vapidPrivate: '',
  };
  const runtime = createApp(config);
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  config.port = (server.address() as any).port;
  config.origin = `http://127.0.0.1:${config.port}`;
  const post = (route: string, body: unknown) =>
    fetch(config.origin + '/api' + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const chat = runtime.store.create('codex', null, 'Spoken clarification');
    const other = runtime.store.create('codex', null, 'Busy');
    runtime.store.db
      .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)')
      .run('clarification', chat.id, 'awaiting_input', null, 1, 1);
    runtime.store.db.prepare('UPDATE conversations SET queue_paused=1 WHERE id=?').run(chat.id);
    runtime.store.enqueue(chat.id, 'Backlog to preserve', []);
    const sendAudio = () => {
      const data = new FormData();
      data.append('audio', new Blob(['test-audio'], { type: 'audio/webm' }), 'reply.webm');
      return fetch(config.origin + `/api/conversations/${chat.id}/turns`, {
        method: 'POST',
        body: data,
      });
    };
    await post(`/conversations/${other.id}/turns`, { text: 'Hold the slot' });
    assert.equal((await sendAudio()).status, 429);
    await post(`/conversations/${other.id}/cancel`, {});
    await until(() => runtime.store.runs(other.id).every((r) => r.status === 'cancelled'));
    let response = await sendAudio();
    for (let i = 0; i < 100 && response.status === 429; i++) {
      await delay(20);
      response = await sendAudio();
    }
    assert.equal(response.status, 202);
    const { runId } = await response.json();
    await until(() =>
      runtime.store.runs(chat.id).some((r) => r.id === runId && r.status === 'complete'),
    );
    assert.equal(runtime.store.queue(chat.id).length, 1);
    assert.equal(runtime.store.conversation(chat.id)?.queue_paused, 1);
    assert.ok(runtime.store.messages(chat.id).some((m) => m.text === 'Usa ambiente staging'));
  } finally {
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => audioServer.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
