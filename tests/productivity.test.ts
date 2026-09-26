import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { Store } from '../server/store';
import { extractDocument, collectExports, prepareDocuments } from '../server/files';

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(25);
  }
  throw new Error('Condition timed out');
}
async function fixture(real = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-productivity-'));
  const bin = path.join(dir, 'fixture.cjs');
  await writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
let input='';process.stdin.on('data', d=>input+=d);process.stdin.on('end',()=>{
  const docs = JSON.parse(input.match(/Documenti della conversazione: (.*)\\n/)[1]);
  if (!docs.length || !fs.readFileSync(docs[0].original,'utf8').includes('spesa')) process.exit(2);
  if (!fs.readFileSync(docs[0].text,'utf8').includes('spesa')) process.exit(3);
  const output = JSON.parse(input.match(/cartella (".*?")\\./)[1]);
  fs.writeFileSync(path.join(output, 'report.txt'), 'Totale: 42 euro');
  fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls'))}, input+'\\n');
  const claude=process.argv.includes('-p');
  console.log(JSON.stringify(claude ? {type:'system',subtype:'init',session_id:'test-session'} : {type:'thread.started',thread_id:'test-session'}));
  console.log(JSON.stringify(claude ? {type:'result',subtype:'success',is_error:false,result:'Report pronto'} : {type:'item.completed',item:{type:'agent_message',text:'Report pronto'}}));
});`,
    { mode: 0o700 },
  );
  const config = {
    ...readConfig(),
    dataDir: dir,
    demo: !real,
    password: 'test-productivity-password-24',
    codexBin: bin,
    claudeBin: bin,
    vapidPublic: '',
    vapidPrivate: '',
  };
  let runtime = createApp(config);
  let server = runtime.app.listen(0, '127.0.0.1');
  let cookie = '';
  async function listen() {
    await new Promise<void>((r) => server.once('listening', r));
    config.port = (server.address() as any).port;
    config.origin = `http://127.0.0.1:${config.port}`;
  }
  await listen();
  async function request(route: string, body?: unknown, auth = true) {
    return fetch(config.origin + '/api' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(auth ? { Cookie: cookie } : {}),
        ...(body === undefined || body instanceof FormData
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  }
  cookie = (await request('/login', { password: config.password })).headers
    .get('set-cookie')!
    .split(';')[0];
  return {
    dir,
    request,
    get store() {
      return runtime.store;
    },
    async restart() {
      await runtime.close();
      await new Promise<void>((r) => server.close(() => r()));
      runtime = createApp(config);
      server = runtime.app.listen(0, '127.0.0.1');
      await listen();
    },
    async close() {
      await runtime.close();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('queue editing, deletion, ordering, pause persistence and one-off immediate send', async () => {
  const f = await fixture();
  try {
    const chat = f.store.create('codex', null, 'Queue controls'),
      other = f.store.create('codex', null, 'Other');
    const base = `/conversations/${chat.id}`;
    assert.equal((await f.request(base + '/queue/pause', { paused: true }, false)).status, 401);
    await f.request(base + '/queue/pause', { paused: true });
    const ids: string[] = [];
    for (const text of ['Primo', 'Secondo', 'Terzo'])
      ids.push((await (await f.request(base + '/turns', { text })).json()).runId);
    assert.equal(f.store.queue(chat.id).length, 3);
    assert.equal(
      (await f.request(base + `/queue/${ids[1]}/edit`, { text: 'Corretto' })).status,
      200,
    );
    assert.equal(
      (await f.request(`/conversations/${other.id}/queue/${ids[1]}/edit`, { text: 'Violazione' }))
        .status,
      409,
    );
    assert.equal(
      (await f.request(base + '/queue/reorder', { runIds: [ids[2], ids[2], ids[0]] })).status,
      409,
    );
    assert.equal(
      (await f.request(base + '/queue/reorder', { runIds: [ids[2], ids[0], ids[1]] })).status,
      200,
    );
    await f.request(base + `/queue/${ids[0]}/delete`, {});
    assert.deepEqual(
      f.store.queue(chat.id).map((m) => m.text),
      ['Terzo', 'Corretto'],
    );
    await f.restart();
    await delay(100);
    assert.equal(f.store.conversation(chat.id)!.queue_paused, 1);
    assert.equal(f.store.queue(chat.id).length, 2);
    await f.request(base + `/queue/${ids[1]}/send-now`, {});
    await until(() =>
      f.store.runs(chat.id).some((r) => r.id === ids[1] && r.status === 'complete'),
    );
    assert.deepEqual(
      f.store.queue(chat.id).map((m) => m.text),
      ['Terzo'],
    );
    assert.equal((await f.request(base + `/queue/${ids[1]}/delete`, {})).status, 409);
    assert.equal(
      (await f.request(base + '/queue/reorder', { runIds: [ids[1], ids[2]] })).status,
      409,
    );
    await f.request(base + '/queue/pause', { paused: false });
    await until(() => f.store.runs(chat.id).every((r) => r.status === 'complete'));
    assert.deepEqual(
      f.store
        .messages(chat.id)
        .filter((m) => m.role === 'user')
        .map((m) => m.text),
      ['Corretto', 'Terzo'],
    );
  } finally {
    await f.close();
  }
});

test('search covers message text with accents, literal wildcard characters, paging, ownership and deletion', async () => {
  const f = await fixture();
  try {
    const chat = f.store.create('codex', null, 'Senza parola nel titolo');
    for (let i = 0; i < 43; i++) {
      const id = randomUUID();
      f.store.db
        .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)')
        .run(id, chat.id, 'complete', null, i, i);
      f.store.addMessage(chat.id, id, i % 2 ? 'user' : 'assistant', `Caffè ${i} al 100%_ sicuro`);
    }
    f.store.enqueue(chat.id, 'Caffè in attesa', []);
    assert.equal((await f.request('/search?q=caffe', undefined, false)).status, 401);
    const page = await (await f.request('/search?q=CAFFE')).json();
    assert.equal(page.results.length, 40);
    assert.equal(page.hasMore, true);
    assert.equal((await (await f.request('/search?q=caffe&offset=40')).json()).results.length, 3);
    assert.equal((await (await f.request('/search?q=100%25_')).json()).results.length, 40);
    assert.equal((await (await f.request('/search?q=inesistente')).json()).results.length, 0);
    assert.equal((await f.request('/search?q=')).status, 400);
    f.store.remove(chat.id);
    assert.equal((await (await f.request('/search?q=caffe')).json()).results.length, 0);
  } finally {
    await f.close();
  }
});

for (const agent of ['claude', 'codex'] as const)
  test(`documents and generated files reach ${agent}, survive forks/restarts, and require authentication`, async () => {
    const f = await fixture(true);
    try {
      const chat = f.store.create(agent, null, 'Documenti'),
        other = f.store.create(agent, null, 'Altro');
      const base = `/conversations/${chat.id}`;
      const form = new FormData();
      form.append('text', 'Analizza');
      form.append('files', new Blob(['voce,spesa\ncena,42'], { type: 'text/csv' }), 'conto.csv');
      assert.equal((await f.request(base + '/turns', form)).status, 202);
      await until(() => f.store.runs(chat.id).at(-1)?.status === 'complete');
      const messages = f.store.messages(chat.id),
        original = messages[0].attachments![0],
        output = messages[1].attachments![0];
      assert.equal(original.mime, 'text/csv');
      assert.equal(output.name, 'report.txt');
      assert.equal(await (await f.request(base + `/files/${output.id}`)).text(), 'Totale: 42 euro');
      assert.equal((await f.request(base + `/files/${output.id}`, undefined, false)).status, 401);
      assert.equal((await f.request(`/conversations/${other.id}/files/${output.id}`)).status, 404);
      assert.equal((await f.request(base + `/images/${original.id}`)).status, 404);
      const response = await f.request(base + `/files/${original.id}`);
      assert.match(response.headers.get('content-disposition')!, /^attachment/);
      const fork = await (await f.request(base + `/messages/${messages[1].id}/fork`, {})).json();
      await f.restart();
      assert.equal(f.store.messages(chat.id)[1].attachments![0].id, output.id);
      await f.request(base + '/turns', { text: 'Continua' });
      await until(() => f.store.runs(chat.id).at(-1)?.status === 'complete');
      f.store.remove(chat.id);
      assert.equal((await f.request(base + `/files/${output.id}`)).status, 404);
      const copied = f.store.messages(fork.id);
      assert.equal(copied[0].attachments![0].mime, 'text/csv');
      assert.notEqual(copied[0].attachments![0].id, original.id);
      assert.equal(
        await (
          await f.request(`/conversations/${fork.id}/files/${copied[1].attachments![0].id}`)
        ).text(),
        'Totale: 42 euro',
      );
      await f.request(`/conversations/${fork.id}/turns`, { text: 'Riprendi dal fork' });
      await until(() => f.store.runs(fork.id).at(-1)?.status === 'complete');
      const bad = new FormData();
      bad.append('files', new Blob(['evil']), 'script.exe');
      assert.equal((await f.request(`/conversations/${fork.id}/turns`, bad)).status, 400);
    } finally {
      await f.close();
    }
  });

test('bounded extraction reads Excel and PDF text, reports unreadable documents and rejects symlink exports', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-extract-'));
  try {
    // Minimal real DOCX package with one text paragraph.
    const docx = Buffer.from(
      'UEsDBBQAAAAIAAqkOl1Rl+gEsQAAABQBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QvQ7CMAyEX6XKilpXDAyo7QKswMALWInbRjQ/StxS3p4UUAcGRvu7O59c3Z6eYjabwcZa9Mx+DxBlTwZj4TzZRFoXDHIaQwce5R07gm1Z7kA6y2Q55yVDNNWRWhwHzk5zWkftbC2SXWSHj245VQv0ftASOWFYKDTVZaIQtKLsioHPaJIKHi4oUE6OJjmL/zGTVT9dc9e2WtLqX9J8cJJi1LYzQ7ESg9puvj3g/YzmBVBLAwQUAAAACAAKpDpdYXsvQ4kAAADyAAAACwAAAF9yZWxzLy5yZWxzjc87DgIhEAbgqxAOsLNaWBigstnWeAECwyMujwwY9fZSWKzGwnLmn3x/Rpxx1T2W3EKsjT3Smpvkofd6BGgmYNJtKhXzSFyhpPsYyUPV5qo9wn6eD0BbgyuxNdliJafF7ji7PCv+YxfnosFTMbeEuf+o+LoYsiaPXfJ7IQv2vZ4Gy0EJ+HhRvQBQSwMEFAAAAAgACqQ6XVAFnr59AAAAqQAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOwQ4CIQxEf4XsB9iNBw8EOfkPnhFwl2RLSYuify+sJl7epJnMdEzTgfwDY67qhVsW3c7TWmvRAOLXiE4OVGLu3p0YXe0nL9CIQ2HyUSTlBTc4zvMJ0KU8WdP0jcJ7aBnggWovvzekrj2sQlK94OkMDHOQd5ad3wL4j7MfUEsBAhQDFAAAAAgACqQ6XVGX6ASxAAAAFAEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACAAKpDpdYXsvQ4kAAADyAAAACwAAAAAAAAAAAAAAgAHiAAAAX3JlbHMvLnJlbHNQSwECFAMUAAAACAAKpDpdUAWevn0AAACpAAAAEQAAAAAAAAAAAAAAgAGUAQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAAQAIAAAAA',
      'base64',
    );
    assert.match(
      await extractDocument({ name: 'test.docx', mime: 'application/octet-stream', data: docx }),
      /Documento Word di prova/,
    );
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Spese').addRow(['spesa', 42]);
    const data = Buffer.from(await workbook.xlsx.writeBuffer());
    assert.match(
      await extractDocument({ name: 'conto.xlsx', mime: 'application/octet-stream', data }),
      /spesa\t42/,
    );
    const stream = 'BT /F1 12 Tf 50 700 Td (Documento di prova) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const [i, obj] of objects.entries()) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    assert.match(
      await extractDocument({ name: 'test.pdf', mime: 'application/pdf', data: Buffer.from(pdf) }),
      /Documento di prova/,
    );
    assert.match(
      await extractDocument({
        name: 'rotto.docx',
        mime: 'application/octet-stream',
        data: Buffer.from('PKbad'),
      }),
      /Estrazione non disponibile/,
    );
    assert.throws(
      () =>
        prepareDocuments([
          { originalname: 'fake.pdf', size: 4, buffer: Buffer.from('fake') } as Express.Multer.File,
        ]),
      /PDF non è valido/,
    );
    const root = path.join(dir, 'output');
    await mkdir(root);
    await writeFile(path.join(root, 'report.txt'), 'ok');
    await writeFile(path.join(dir, 'private.txt'), 'secret');
    await symlink(path.join(dir, 'private.txt'), path.join(root, 'link.txt'));
    const exports = await collectExports(root);
    assert.equal(exports.files.length, 1);
    assert.equal(exports.warnings.length, 1);
    await symlink(root, path.join(dir, 'linked'));
    assert.equal((await collectExports(path.join(dir, 'linked'))).files.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
