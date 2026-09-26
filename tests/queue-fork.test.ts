import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { Store } from '../server/store';
import sharp from 'sharp';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 12000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for task state');
    await delay(25);
  }
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-queue-'));
  const bin = path.join(dir, 'agent.cjs');
  const log = path.join(dir, 'calls.jsonl');
  await writeFile(log, '');
  await writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
const log = data => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(data) + '\\n');
process.stdin.on('data', data => input += data);
process.stdin.on('end', () => {
  const claude = args.includes('-p');
  let imageCount = args.filter(a => a === '--image').length;
  if (claude && args.includes('--input-format')) {
    const content = JSON.parse(input).message.content;
    imageCount = content.filter(c => c.type === 'image').length;
    input = content.filter(c => c.type === 'text').map(c => c.text).join('');
  }
  const session = 'fixture-' + require('node:crypto').randomUUID();
  log({type:'start', input, args, imageCount, cwd:process.cwd()});
  console.log(JSON.stringify(claude ? {type:'system',subtype:'init',session_id:session} : {type:'thread.started',thread_id:session}));
  process.on('SIGTERM', () => setTimeout(() => {log({type:'stop',input}); process.exit(0);}, 100));
  setTimeout(() => {
    log({type:'end', input});
    if (input.endsWith('FAIL')) process.exit(1);
    console.log(JSON.stringify(claude ? {type:'result',subtype:'success',is_error:false,result:'Risposta completata',session_id:session} : {type:'item.completed',item:{type:'agent_message',text:'Risposta completata'}}));
  }, input.endsWith('SLOW') ? 3000 : 180);
});
`,
    { mode: 0o700 },
  );
  const config = {
    ...readConfig(),
    dataDir: dir,
    demo: false,
    password: '',
    maxRuns: 2,
    claudeBin: bin,
    codexBin: bin,
    vapidPublic: '',
    vapidPrivate: '',
  };
  let runtime = createApp(config);
  let server = runtime.app.listen(0, '127.0.0.1');
  let port = 0;
  async function listening() {
    await new Promise<void>((r) => server.once('listening', r));
    port = (server.address() as { port: number }).port;
    config.port = port;
  }
  await listening();
  const request = (route: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}/api${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body instanceof FormData || body === undefined
          ? {}
          : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  return {
    dir,
    config,
    request,
    get store() {
      return runtime.store;
    },
    calls: async () =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    async restart() {
      await runtime.close();
      await new Promise<void>((r) => server.close(() => r()));
      runtime = createApp(config);
      server = runtime.app.listen(0, '127.0.0.1');
      await listening();
    },
    async close() {
      await runtime.close();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('queue persists, runs FIFO after failure and respects per-chat and global capacity', async () => {
  const f = await fixture();
  try {
    const chat = f.store.create('codex', null, 'Queue');
    const base = `/conversations/${chat.id}`;
    const first = (await (await f.request(`${base}/turns`, { text: 'FAIL' })).json()) as any;
    const second = (await (await f.request(`${base}/turns`, { text: 'Secondo' })).json()) as any;
    const third = (await (await f.request(`${base}/turns`, { text: 'Terzo' })).json()) as any;
    assert.equal(second.queued, true);
    assert.equal(third.queued, true);
    const snapshot = (await (await f.request(base)).json()) as any;
    assert.deepEqual(
      snapshot.queue.map((m: any) => m.text),
      ['Secondo', 'Terzo'],
    );
    assert.equal(f.store.list()[0].status, 'running');
    assert.equal(snapshot.messages.length, 1);
    await until(() => f.store.runs(chat.id).every((r) => ['error', 'complete'].includes(r.status)));
    assert.equal(f.store.runs(chat.id).find((r) => r.id === first.runId)?.status, 'error');
    assert.deepEqual(
      f.store.messages(chat.id).map((m) => m.text),
      ['FAIL', 'Secondo', 'Risposta completata', 'Terzo', 'Risposta completata'],
    );
    assert.deepEqual(
      (await f.calls()).map((c) => c.type),
      ['start', 'end', 'start', 'end', 'start', 'end'],
    );
    const a = f.store.create('codex', null, 'A'),
      b = f.store.create('codex', null, 'B');
    await f.request(`${base}/turns`, { text: 'SLOW' });
    await f.request(`/conversations/${a.id}/turns`, { text: 'SLOW' });
    assert.equal(
      (await f.request(`/conversations/${b.id}/turns`, { text: 'No slot' })).status,
      429,
    );
    assert.equal((await f.request(`${base}/turns`, { text: 'Accepted in busy chat' })).status, 202);
    await f.request(`${base}/cancel`, {});
    await until(() => f.store.messages(chat.id).some((m) => m.text === 'Accepted in busy chat'));
    assert.equal(f.store.runs(a.id)[0].status, 'running');
  } finally {
    await f.close();
  }
});

test('send now waits for process termination, prioritizes the chosen message, and preserves the rest', async () => {
  const f = await fixture();
  try {
    const chat = f.store.create('codex', null, 'Immediate');
    const other = f.store.create('claude', null, 'Other');
    const base = `/conversations/${chat.id}`;
    const first = (await (await f.request(`${base}/turns`, { text: 'SLOW' })).json()) as any;
    await until(async () => (await f.calls()).length > 0);
    await f.request(`${base}/turns`, { text: 'FIFO' });
    const urgent = (await (await f.request(`${base}/turns`, { text: 'Urgente' })).json()) as any;
    assert.equal(
      (await f.request(`/conversations/${other.id}/queue/${urgent.runId}/send-now`, {})).status,
      404,
    );
    const responses = await Promise.all([
      f.request(`${base}/queue/${urgent.runId}/send-now`, {}),
      f.request(`${base}/queue/${urgent.runId}/send-now`, {}),
    ]);
    assert.ok(responses.every((r) => r.status === 202));
    await until(() =>
      f.store.runs(chat.id).every((r) => ['cancelled', 'complete'].includes(r.status)),
    );
    assert.equal(f.store.runs(chat.id).find((r) => r.id === first.runId)?.status, 'cancelled');
    const calls = await f.calls();
    assert.deepEqual(
      calls.map((c) => c.type),
      ['start', 'stop', 'start', 'end', 'start', 'end'],
    );
    assert.ok(calls[2].input.endsWith('Urgente'));
    assert.ok(calls[4].input.endsWith('FIFO'));
    assert.deepEqual(
      f.store.messages(chat.id).map((m) => m.text),
      ['SLOW', 'Urgente', 'Risposta completata', 'FIFO', 'Risposta completata'],
    );
    assert.equal((await f.request(`${base}/queue/${urgent.runId}/send-now`, {})).status, 409);
  } finally {
    await f.close();
  }
});

test('queued inputs survive shutdown and resume once without repeating the interrupted task', async () => {
  const f = await fixture();
  try {
    const chat = f.store.create('codex', null, 'Restart');
    const base = `/conversations/${chat.id}`;
    await f.request(`${base}/turns`, { text: 'SLOW' });
    await until(async () => (await f.calls()).length > 0);
    await f.request(`${base}/turns`, { text: 'Dopo riavvio' });
    await f.restart();
    await until(() => f.store.runs(chat.id).at(-1)?.status === 'complete');
    const calls = (await f.calls()).filter((c) => c.type === 'start');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].input.endsWith('Dopo riavvio'));
    assert.equal(f.store.queue(chat.id).length, 0);
  } finally {
    await f.close();
  }
});

test('crash recovery keeps queued messages while marking the active run interrupted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-queue-crash-'));
  let store = new Store(dir);
  try {
    const chat = store.create('codex', null, 'Crash');
    store.db
      .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)')
      .run('active', chat.id, 'running', null, 1, 1);
    store.enqueue(chat.id, 'Conservami', []);
    store.close();
    store = new Store(dir);
    assert.equal(store.runs(chat.id)[0].status, 'interrupted');
    assert.equal(store.queue(chat.id)[0].text, 'Conservami');
    store.remove(chat.id);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM run_queue').get()!.n, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('queued images survive restart and reach the next agent turn exactly once', async () => {
  const f = await fixture();
  try {
    const chat = f.store.create('codex', null, 'Queued image');
    const base = `/conversations/${chat.id}`;
    await f.request(`${base}/turns`, { text: 'SLOW' });
    await until(async () => (await f.calls()).length > 0);
    const data = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append('text', 'Esamina questa immagine');
    form.append('images', new Blob([new Uint8Array(data)], { type: 'image/png' }), 'queue.png');
    assert.equal((await f.request(`${base}/turns`, form)).status, 202);
    assert.equal(f.store.queue(chat.id)[0].attachments?.length, 1);
    await f.restart();
    await until(() => f.store.runs(chat.id).at(-1)?.status === 'complete');
    const calls = (await f.calls()).filter((c) => c.type === 'start');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].imageCount, 1);
    assert.equal(
      f.store.messages(chat.id).filter((m) => m.text === 'Esamina questa immagine').length,
      1,
    );
    assert.equal(
      f.store.messages(chat.id).find((m) => m.text === 'Esamina questa immagine')?.attachments
        ?.length,
      1,
    );
  } finally {
    await f.close();
  }
});

for (const agent of ['claude', 'codex'] as const) {
  test(`fork ${agent}: bounded history, independent attachments/settings/workspace/session and real CLI context`, async () => {
    const f = await fixture();
    try {
      const original = f.store.create(agent, 'example/project', 'Origine');
      const workspace = path.join(f.dir, 'original');
      await mkdir(workspace);
      f.store.db
        .prepare('UPDATE conversations SET model=?,effort=?,session_id=?,workspace=? WHERE id=?')
        .run('test-model', 'high', 'original-session', workspace, original.id);
      const runId = randomUUID();
      f.store.db
        .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)')
        .run(runId, original.id, 'complete', null, 1, 1);
      const image = await sharp({
        create: { width: 2, height: 2, channels: 3, background: '#ffffff' },
      })
        .jpeg()
        .toBuffer();
      const user = f.store.addMessage(original.id, runId, 'user', 'Contesto da conservare', '', [
        { name: 'original.jpg', mime: 'image/jpeg', data: image },
      ]);
      const target = f.store.addMessage(
        original.id,
        runId,
        'assistant',
        'Risposta da forcare',
        'Voce da conservare',
      );
      const later = randomUUID();
      f.store.db
        .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)')
        .run(later, original.id, 'complete', null, 2, 2);
      f.store.addMessage(original.id, later, 'user', 'SEGRETO SUCCESSIVO');
      f.store.addMessage(original.id, later, 'assistant', 'RISPOSTA SUCCESSIVA');
      f.store.enqueue(original.id, 'MESSAGGIO IN CODA ESCLUSO', []);
      const base = `/conversations/${original.id}`;
      assert.equal((await f.request(`${base}/messages/${user.id}/fork`, {})).status, 404);
      const foreign = f.store.create(agent, null, 'Estranea');
      assert.equal(
        (await f.request(`/conversations/${foreign.id}/messages/${target.id}/fork`, {})).status,
        404,
      );
      const response = await f.request(`${base}/messages/${target.id}/fork`, {});
      assert.equal(response.status, 201);
      const fork = (await response.json()) as any;
      assert.notEqual(fork.id, original.id);
      assert.equal(fork.model, 'test-model');
      assert.equal(fork.effort, 'high');
      assert.equal(fork.repo, 'example/project');
      assert.equal(fork.session_id, null);
      assert.equal(fork.workspace, null);
      const copied = f.store.messages(fork.id);
      assert.deepEqual(
        copied.map((m) => m.text),
        ['Contesto da conservare', 'Risposta da forcare'],
      );
      assert.equal(copied[1].voice_text, target.voice_text);
      assert.notEqual(copied[0].attachments![0].id, f.store.attachments(user.id)[0].id);
      assert.equal(f.store.queue(fork.id).length, 0);
      // Use a pre-created separate directory: no external git access in the fixture.
      const forkWorkspace = path.join(f.dir, 'fork');
      await mkdir(forkWorkspace);
      f.store.db
        .prepare('UPDATE conversations SET workspace=? WHERE id=?')
        .run(forkWorkspace, fork.id);
      f.store.remove(original.id);
      const attached = await f.request(
        `/conversations/${fork.id}/images/${copied[0].attachments![0].id}`,
      );
      assert.equal(attached.status, 200);
      assert.deepEqual(Buffer.from(await attached.arrayBuffer()), image);
      await f.request(`/conversations/${fork.id}/turns`, { text: 'Continua da qui' });
      await until(() => f.store.runs(fork.id).at(-1)?.status === 'complete');
      const call = (await f.calls()).find((c) => c.type === 'start');
      assert.match(call.input, /Contesto da conservare/);
      assert.match(call.input, /Risposta da forcare/);
      assert.match(call.input, /Continua da qui/);
      assert.doesNotMatch(
        call.input,
        /SEGRETO SUCCESSIVO|RISPOSTA SUCCESSIVA|MESSAGGIO IN CODA ESCLUSO/,
      );
      assert.equal(call.imageCount, 1);
      assert.ok(!call.args.includes('original-session'));
      assert.ok(!call.args.includes('--resume') && !call.args.includes('resume'));
      assert.equal(call.cwd, forkWorkspace);
      assert.notEqual(f.store.conversation(fork.id)?.session_id, 'original-session');
      await f.request(`/conversations/${fork.id}/turns`, { text: 'Ancora' });
      await until(() => f.store.runs(fork.id).at(-1)?.status === 'complete');
      const next = (await f.calls()).filter((c) => c.type === 'start')[1];
      assert.ok(next.args.includes(agent === 'claude' ? '--resume' : 'resume'));
      assert.doesNotMatch(next.input, /Contesto da conservare/);
    } finally {
      await f.close();
    }
  });
}
