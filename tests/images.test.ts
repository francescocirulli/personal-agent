import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { Store } from '../server/store';

test(
  'image attachments: real HTTP upload, CLI stdin/argv on new and resumed turns, authorization, persistence and deletion',
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pa-images-'));
    const fixture = path.join(dir, 'agent.cjs');
    await writeFile(
      fixture,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (data) => input += data);
process.stdin.on('end', () => {
  const claude = args.includes('-p');
  const paths = args.flatMap((value, i) => value === '--image' ? [args[i+1]] : []);
  let count = paths.length;
  if (claude) {
    if (!args.includes('stream-json') || !args.includes('--input-format')) process.exit(2);
    const message = JSON.parse(input);
    const images = message.message.content.filter(c => c.type === 'image');
    count = images.length;
    if (!images.every(i => i.source.media_type === 'image/jpeg' && Buffer.from(i.source.data, 'base64')[0] === 255)) process.exit(3);
  } else if (!paths.every(p => fs.readFileSync(p)[0] === 255)) process.exit(4);
  fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({args, paths, count, input: claude ? JSON.parse(input).message.content.filter(c => c.type === 'text') : input}) + '\\n');
  if (claude) {
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fixture-session'}));
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Immagini ricevute: '+count,session_id:'fixture-session'}));
  } else {
    console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Immagini ricevute: '+count}}));
  }
});
`,
      { mode: 0o700 },
    );
    const config = {
      ...readConfig(),
      dataDir: dir,
      demo: false,
      password: 'images-test-password-24-chars',
      claudeBin: fixture,
      codexBin: fixture,
      vapidPublic: '',
      vapidPrivate: '',
    };
    const runtime = createApp(config),
      server = runtime.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    config.port = (server.address() as any).port;
    config.origin = `http://127.0.0.1:${config.port}`;
    let cookie = '';
    const request = (url: string, body?: unknown) =>
      fetch(config.origin + '/api' + url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: cookie,
          ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        },
        body:
          body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      });
    const png = await sharp({ create: { width: 100, height: 80, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    function form(data: Uint8Array = png, type = 'image/png', count = 1) {
      const body = new FormData();
      for (let i = 0; i < count; i++)
        body.append('images', new Blob([new Uint8Array(data)], { type }), `test-${i}.png`);
      return body;
    }
    let preservedId = '';
    try {
      const unauthorized = runtime.store.create('codex', null, 'Authentication');
      assert.equal((await request(`/conversations/${unauthorized.id}/turns`, form())).status, 401);
      cookie = (await request('/login', { password: config.password })).headers
        .get('set-cookie')!
        .split(';')[0];
      for (const agent of ['claude', 'codex'] as const) {
        const chat = runtime.store.create(agent, null, 'Immagini');
        preservedId = chat.id;
        assert.equal(
          (await request(`/conversations/${chat.id}/turns`, form(Buffer.from('not an image'))))
            .status,
          400,
        );
        assert.equal(
          (
            await request(
              `/conversations/${chat.id}/turns`,
              form(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'),
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await request(
              `/conversations/${chat.id}/turns`,
              form(Buffer.alloc(5 * 1024 * 1024 + 1)),
            )
          ).status,
          400,
        );
        assert.equal(
          (await request(`/conversations/${chat.id}/turns`, form(png, 'image/png', 5))).status,
          413,
        );
        const mixed = form();
        mixed.append('audio', new Blob(['fake'], { type: 'audio/webm' }), 'voice.webm');
        assert.equal((await request(`/conversations/${chat.id}/turns`, mixed)).status, 400);
        assert.equal(runtime.store.runs(chat.id).length, 0);
        for (let turn = 0; turn < 2; turn++) {
          const body = form(png, 'image/png', turn + 1);
          if (turn) body.append('text', 'Confronta queste immagini');
          const response = await request(`/conversations/${chat.id}/turns`, body);
          assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
          for (let i = 0; i < 100 && runtime.store.runs(chat.id).at(-1)?.status === 'running'; i++)
            await delay(30);
          assert.equal(
            runtime.store.runs(chat.id).at(-1)?.status,
            'complete',
            runtime.store.runs(chat.id).at(-1)?.error || '',
          );
          const detail = (await (await request(`/conversations/${chat.id}`)).json()) as any;
          const message = detail.messages.at(-2);
          assert.equal(message.attachments.length, turn + 1);
          assert.equal(message.attachments[0].mime, 'image/jpeg');
          assert.equal('data' in message.attachments[0], false);
          const url = `/conversations/${chat.id}/images/${message.attachments[0].id}`;
          const image = await request(url);
          assert.equal(image.headers.get('content-type'), 'image/jpeg');
          assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).width, 100);
          assert.equal(
            (await request(`/conversations/${unauthorized.id}/images/${message.attachments[0].id}`))
              .status,
            404,
          );
          assert.equal((await fetch(config.origin + '/api' + url)).status, 401);
        }
        if (agent === 'claude') {
          const attachments = runtime.store.messages(chat.id)[0].attachments!;
          assert.equal((await request(`/conversations/${chat.id}/delete`, {})).status, 200);
          assert.equal(
            runtime.store.db
              .prepare('SELECT id FROM attachments WHERE id=?')
              .get(attachments[0].id),
            undefined,
          );
        }
      }
      const calls = (await readFile(path.join(dir, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        calls.map((c) => c.count),
        [1, 2, 1, 2],
      );
      assert.ok(calls[1].args.includes('--resume'));
      assert.ok(calls[3].args.includes('resume'));
      assert.ok(calls[3].args.includes('fixture-session'));
      assert.deepEqual(await readdir(path.join(dir, 'image-runs')), []);
      assert.equal(
        runtime.store.db
          .prepare("SELECT count(*) AS n FROM events WHERE data LIKE '%base64%'")
          .get()!.n,
        0,
      );
    } finally {
      await runtime.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
    const db = new Store(dir);
    assert.equal(db.messages(preservedId)[0].attachments?.length, 1);
    db.close();
    await rm(dir, { recursive: true, force: true });
  },
);
