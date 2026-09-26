import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, get as httpGet } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store';
import { normalize, splitVoice } from '../server/protocol';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { AudioService, pcmToWav } from '../server/audio';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { commandFor, runProcess } from '../server/runner';

test('speech tags are extracted without reading fenced examples', () => {
  const result = splitVoice(
    'Risultato.\n```html\n<voce>esempio</voce>\n```\n<voce>Ho finito.</voce>',
  );
  assert.equal(result.voice, 'Ho finito.');
  assert.match(result.text, /<voce>esempio<\/voce>/);
  assert.match(result.text, /Risultato/);
  assert.equal(splitVoice('<voce>Solo voce.</voce>').text, 'Solo voce.');
  assert.doesNotMatch(
    splitVoice('```js\nsecret()\n```\nLeggi [qui](https://example.com).').voice,
    /secret|https:/,
  );
});
test('CLI normalization handles failures, sessions and excludes subagent output', () => {
  assert.deepEqual(normalize('codex', { type: 'thread.started', thread_id: 'abc' }), [
    { type: 'session', value: 'abc' },
  ]);
  assert.equal(
    normalize('codex', { type: 'turn.failed', error: { message: 'sensitive raw' } })[0].type,
    'failure',
  );
  assert.deepEqual(
    normalize('claude', {
      type: 'assistant',
      parent_tool_use_id: 'child',
      message: { content: [{ type: 'text', text: 'private' }] },
    }),
    [],
  );
  assert.equal(
    normalize('claude', { type: 'result', is_error: true, result: 'sensitive' })[0].type,
    'failure',
  );
});
test('restart marks in-flight work interrupted without repeating effects', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-db-'));
  let db = new Store(dir);
  const chat = db.create('codex', null, 'Test');
  db.db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)').run('run', chat.id, 'running', null, 1, 1);
  db.addMessage(chat.id, 'run', 'user', 'Preserve me');
  db.close();
  db = new Store(dir);
  assert.equal(db.runs(chat.id)[0].status, 'interrupted');
  assert.equal(db.messages(chat.id)[0].text, 'Preserve me');
  db.close();
  await rm(dir, { recursive: true, force: true });
});
test('subscription commands resume exact sessions and keep prompt off argv', () => {
  const config = readConfig(),
    dbChat: any = { agent: 'codex', session_id: 'specific', workspace: '/tmp' };
  const command = commandFor(config, dbChat);
  assert.deepEqual(command.args.slice(0, 2), ['exec', 'resume']);
  assert.ok(command.args.includes('specific'));
  assert.ok(!command.args.includes('--last'));
  assert.ok(command.args.includes('forced_login_method="chatgpt"'));
});
test('process cancellation terminates a spawned process', async () => {
  const signal = new AbortController();
  const execution = runProcess(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    tmpdir(),
    signal.signal,
    '',
    () => {},
  );
  await delay(70);
  signal.abort();
  await assert.rejects(execution, /interrotto/);
});
test('HTTP flow: concurrency, reconnect persistence, cancellation, malformed input and origin', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-http-'));
  const config = {
    ...readConfig(),
    dataDir: dir,
    demo: true,
    password: '',
    maxRuns: 2,
    port: 4310,
    origin: 'http://localhost:4310',
  };
  const runtime = createApp(config),
    server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  config.port = address.port;
  const request = (url: string, body?: unknown, headers = {}) =>
    fetch(`http://127.0.0.1:${address.port}/api${url}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Host: 'localhost:4310',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal(
      (await request('/conversations', { agent: 'codex', repo: '--bad/../../' })).status,
      400,
    );
    assert.equal(
      (await request('/conversations', { agent: 'codex' }, { Origin: 'https://attacker.example' }))
        .status,
      403,
    );
    const a = (await (await request('/conversations', { agent: 'claude' })).json()) as any;
    const b = (await (await request('/conversations', { agent: 'codex' })).json()) as any;
    const c = (await (await request('/conversations', { agent: 'codex' })).json()) as any;
    assert.equal(
      (await request(`/conversations/${a.id}/turns`, { text: 'Primo task' })).status,
      202,
    );
    assert.equal(
      (await request(`/conversations/${a.id}/turns`, { text: 'Messaggio in coda' })).status,
      202,
    );
    assert.equal((await request(`/conversations/${a.id}/delete`, {})).status, 409);
    assert.equal((await request(`/conversations/${a.id}/rename`, { title: '  ' })).status, 400);
    assert.equal(
      (await request(`/conversations/${a.id}/rename`, { title: 'Titolo scelto da me' })).status,
      200,
    );
    assert.equal(
      (await request(`/conversations/${b.id}/turns`, { text: 'Secondo task' })).status,
      202,
    );
    assert.equal((await request(`/conversations/${c.id}/turns`, { text: 'Capacity' })).status, 429);
    const sseController = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${address.port}/api/events`, {
      headers: { Host: 'localhost:4310', 'Last-Event-ID': '1' },
      signal: sseController.signal,
    });
    const chunk = await stream.body!.getReader().read();
    assert.match(new TextDecoder().decode(chunk.value), /data:/);
    sseController.abort();
    await request(`/conversations/${b.id}/cancel`, {});
    await delay(3000);
    const detail = (await (await request(`/conversations/${a.id}`)).json()) as any;
    assert.equal(detail.runs[0].status, 'complete');
    assert.equal(detail.title, 'Titolo scelto da me');
    assert.equal(detail.messages.length, 4);
    assert.equal(detail.queue.length, 0);
    assert.ok(detail.messages[1].voice_text);
    assert.equal(
      ((await (await request(`/conversations/${b.id}`)).json()) as any).runs[0].status,
      'cancelled',
    );
    assert.equal(
      (await request(`/conversations/${c.id}/messages/${detail.messages[1].id}/audio`, {})).status,
      404,
    );
    await mkdir(detail.workspace, { recursive: true });
    await writeFile(path.join(detail.workspace, 'keep.txt'), 'Preserve project work');
    const lastEvent = runtime.store.db.prepare('SELECT max(id) AS id FROM events').get()!.id;
    assert.equal((await request(`/conversations/${a.id}/delete`, {})).status, 200);
    assert.equal((await request(`/conversations/${a.id}`)).status, 404);
    assert.equal(
      (await request(`/conversations/${a.id}/messages/${detail.messages[1].id}/audio`)).status,
      404,
    );
    assert.equal((await request(`/conversations/${b.id}`)).status, 200);
    assert.equal(runtime.store.messages(a.id).length, 0);
    assert.equal(runtime.store.runs(a.id).length, 0);
    assert.equal(runtime.store.activities(a.id).length, 0);
    assert.equal(
      await readFile(path.join(detail.workspace, 'keep.txt'), 'utf8'),
      'Preserve project work',
    );
    assert.ok(
      Number(runtime.store.db.prepare('SELECT max(id) AS id FROM events').get()!.id) >
        Number(lastEvent),
    );
    for (const row of runtime.store.db
      .prepare("SELECT data FROM events WHERE json_extract(data,'$.conversationId')=?")
      .all(a.id))
      assert.deepEqual(JSON.parse(String(row.data)), { type: 'deleted', conversationId: a.id });
  } finally {
    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
test('authentication protects history, SSE and audio', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-auth-'));
  const config = {
    ...readConfig(),
    dataDir: dir,
    password: 'a-secure-test-password-only',
    port: 4310,
    origin: 'http://localhost:4310',
  };
  const runtime = createApp(config);
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  config.port = (server.address() as any).port;
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  try {
    // Node fetch can replace Host; use raw HTTP to exercise Railway's header.
    const probe = (url: string) =>
      new Promise<number | undefined>((resolve, reject) => {
        httpGet(url, { headers: { Host: 'healthcheck.railway.app' } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }).on('error', reject);
      });
    assert.equal(await probe(base.replace(/\/api$/, '/healthz')), 200);
    assert.equal(await probe(base + '/conversations'), 403);
    for (const endpoint of [
      '/settings/audio',
      '/settings/audio/models',
      '/conversations',
      '/events',
      '/github',
      '/conversations/test/messages/test/audio',
      '/audio/' + 'a'.repeat(64),
    ])
      assert.equal(
        (await fetch(base + endpoint, { headers: { Host: 'localhost:4310' } })).status,
        401,
      );
    const login = await fetch(base + '/login', {
      method: 'POST',
      headers: { Host: 'localhost:4310', 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'a-secure-test-password-only' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal(
      (
        await fetch(base + '/conversations', {
          headers: { Host: 'localhost:4310', Cookie: cookie.split(';')[0] },
        })
      ).status,
      200,
    );
  } finally {
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
test('message media URL supports Safari byte ranges and enforces message ownership', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-media-'));
  const config = {
    ...readConfig(),
    dataDir: dir,
    password: '',
    audioKey: 'test-only',
    ttsModel: 'google/test',
    demo: true,
  };
  const runtime = createApp(config),
    server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  config.port = (server.address() as any).port;
  const base = `http://127.0.0.1:${config.port}/api`;
  try {
    const a = runtime.store.create('codex', null, 'Audio');
    const b = runtime.store.create('codex', null, 'Other chat');
    runtime.store.db
      .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)')
      .run('audio-run', a.id, 'complete', null, 1, 1);
    const message = runtime.store.addMessage(a.id, 'audio-run', 'assistant', 'Ciao', 'Ciao');
    const key = createHash('sha256')
      .update(JSON.stringify([config.audioBase, config.ttsModel, config.voice, 'Ciao']))
      .digest('hex');
    const wav = pcmToWav(Buffer.alloc(4800));
    await mkdir(path.join(dir, 'audio'));
    await writeFile(path.join(dir, 'audio', key + '.wav'), wav);
    const url = `${base}/conversations/${a.id}/messages/${message.id}/audio`;
    const probe = await fetch(url, { headers: { Range: 'bytes=0-1' } });
    assert.equal(probe.status, 206);
    assert.equal(probe.headers.get('content-range'), `bytes 0-1/${wav.length}`);
    assert.match(probe.headers.get('content-type')!, /audio\/wav/);
    assert.deepEqual(Buffer.from(await probe.arrayBuffer()), wav.subarray(0, 2));
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), wav);
    assert.equal(
      (await fetch(`${base}/conversations/${b.id}/messages/${message.id}/audio`)).status,
      404,
    );
  } finally {
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
test('audio is cached and simultaneous replays make only one provider request', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-audio-'));
  let calls = 0;
  const upstream = createServer(async (req, res) => {
    calls++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.response_format, 'mp3');
    assert.equal(body.input, 'Ciao');
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(Buffer.from([73, 68, 51, 1, 2, 3]));
  });
  upstream.listen(0, '127.0.0.1');
  await new Promise<void>((r) => upstream.once('listening', r));
  const service = new AudioService({
    ...readConfig(),
    dataDir: dir,
    ttsModel: 'test/mp3-model',
    audioKey: 'test-only',
    audioBase: `http://127.0.0.1:${(upstream.address() as any).port}`,
  });
  try {
    const [a, b] = await Promise.all([service.speech('Ciao'), service.speech('Ciao')]);
    assert.equal(a, b);
    assert.equal(calls, 1);
    await service.speech('Ciao');
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((r) => upstream.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('audio settings persist, validate model capabilities and preserve cached formats across model changes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-settings-'));
  const calls: any[] = [];
  let catalogDown = false;
  const upstream = createServer(async (req, res) => {
    if (req.url?.startsWith('/models?')) {
      if (catalogDown) {
        res.writeHead(503);
        res.end();
        return;
      }
      const modality = req.url.includes('transcription') ? 'transcription' : 'speech';
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          data: [
            {
              id: modality === 'speech' ? 'test/mp3-tts' : 'test/transcribe',
              name: 'Test model',
              architecture: { output_modalities: [modality] },
            },
          ],
        }),
      );
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    res.end(body.response_format === 'pcm' ? Buffer.alloc(4800) : Buffer.from('ID3test-audio'));
  });
  upstream.listen(0, '127.0.0.1');
  await new Promise<void>((r) => upstream.once('listening', r));
  const config = {
    ...readConfig(),
    password: '',
    demo: false,
    dataDir: dir,
    audioKey: 'test-only',
    audioBase: `http://127.0.0.1:${(upstream.address() as any).port}`,
    ttsModel: 'google/test',
    sttModel: 'test/original',
    voice: 'Kore',
  };
  let runtime = createApp(config),
    server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  config.port = (server.address() as any).port;
  const request = (endpoint: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${config.port}/api${endpoint}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    const initial = (await (await request('/settings/audio')).json()) as any;
    assert.equal(initial.voice, 'Kore');
    assert.equal(initial.audioKey, undefined);
    const chat = runtime.store.create('codex', null, 'Test');
    runtime.store.db
      .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)')
      .run('settings-run', chat.id, 'complete', null, 1, 1);
    const message = runtime.store.addMessage(chat.id, 'settings-run', 'assistant', 'Ciao', 'Ciao');
    const endpoint = `/conversations/${chat.id}/messages/${message.id}/audio`;
    const first = await request(endpoint, {});
    const oldUrl = ((await first.json()) as any).url;
    const next = { sttModel: 'test/transcribe', ttsModel: 'test/mp3-tts', voice: 'test-voice' };
    assert.equal(
      (await request('/settings/audio', { ...next, ttsModel: 'test/not-speech' })).status,
      400,
    );
    assert.equal((await request('/settings/audio', { ...next, voice: '' })).status, 400);
    assert.equal(
      (await request('/settings/audio', { ...next, audioKey: 'never-expose' })).status,
      400,
    );
    assert.equal((await request('/settings/audio', next)).status, 200);
    const mp3 = await request(endpoint);
    assert.match(mp3.headers.get('content-type')!, /audio\/mpeg/);
    assert.equal(Buffer.from(await mp3.arrayBuffer()).toString(), 'ID3test-audio');
    assert.equal(calls.at(-1).model, next.ttsModel);
    assert.equal(calls.at(-1).voice, next.voice);
    const wav = await request(oldUrl.replace('/api', ''));
    assert.match(wav.headers.get('content-type')!, /audio\/wav/);
    assert.equal(Buffer.from(await wav.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
    runtime = createApp(config);
    server = runtime.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    config.port = (server.address() as any).port;
    const persisted = (await (await request('/settings/audio')).json()) as any;
    assert.deepEqual(persisted, { ...next, defaults: initial.defaults });
    catalogDown = true;
    assert.equal(
      (await request('/settings/audio', { ...next, ttsModel: 'test/other' })).status,
      503,
    );
    assert.equal((await request('/settings/audio', initial.defaults)).status, 200);
  } finally {
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
