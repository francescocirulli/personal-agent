import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { parseAgentCommand } from '../src/agentCommands';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { runAgentCommand, formatCodexUsage } from '../server/agent-commands';
import { codexRpc } from '../server/codex-rpc';
import { agentEnvironment } from '../server/runner';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-slash-test-'));
  const bin = path.join(dir, 'cli.cjs');
  const log = path.join(dir, 'calls.jsonl');
  await writeFile(log, '');
  await writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(value)+'\\n');
const send = value => console.log(JSON.stringify(value));
log({args, secret:!!process.env.OPENROUTER_API_KEY});
if (args.includes('app-server')) {
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const m=JSON.parse(line); log(m);
    const reply = result => send({id:m.id,result});
    if(m.method==='initialize') reply({});
    if(m.method==='account/usage/read') reply({summary:{lifetimeTokens:1234,peakDailyTokens:400}});
    if(m.method==='account/rateLimits/read') reply({rateLimits:{primary:{usedPercent:12,windowDurationMins:300}}});
    if(m.method==='thread/read') reply({thread:{id:m.params.threadId,model:'fixture-model',reasoningEffort:'high'}});
    if(m.method==='thread/resume') {
      send({method:'thread/tokenUsage/updated',params:{threadId:m.params.threadId,tokenUsage:{last:{inputTokens:999999},modelContextWindow:1000}}});
      reply({thread:{id:m.params.threadId}});
    }
    if(m.method==='thread/compact/start') {
      reply({});
      send({method:'item/completed',params:{threadId:'wrong-thread',item:{type:'contextCompaction'}}});
      send({method:'turn/completed',params:{threadId:'wrong-thread',turn:{status:'completed'}}});
      setTimeout(()=>{
        send({method:'item/completed',params:{threadId:m.params.threadId,item:{type:'contextCompaction'}}});
        send({method:'thread/tokenUsage/updated',params:{threadId:m.params.threadId,tokenUsage:{last:{inputTokens:120},total:{inputTokens:99999},modelContextWindow:1000}}});
        log({completed:m.params.threadId});
        send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{status:'completed'}}});
      },150);
    }
  });
} else {
  let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
    log({input});
    send({type:'system',subtype:'init',session_id:'fixture-session',model:'fixture-model'});
    if(input.startsWith('/')) {
      const command=input.slice(1);
      if(command==='compact') send({type:'system',subtype:'compact_boundary'});
      if(command==='context') send({type:'assistant',local_command_run:{command},context_usage:{total_tokens:80,raw_max_tokens:1000}});
      send({type:'result',local_command:command,is_error:false,result:'Native '+input});
    } else send({type:'result',is_error:false,result:'Normal response'});
  });
}
`,
    { mode: 0o700 },
  );
  const config = {
    ...readConfig(),
    dataDir: dir,
    demo: false,
    password: '',
    audioKey: '',
    claudeBin: bin,
    codexBin: bin,
    vapidPublic: '',
    vapidPrivate: '',
  };
  const runtime = createApp(config);
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  config.origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = (route: string, body?: unknown) =>
    fetch(config.origin + '/api' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    dir,
    bin,
    config,
    ...runtime,
    request,
    calls: async () =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((x) => JSON.parse(x)),
    cleanup: async () => {
      await runtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 300; n++) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error('Timed out');
}

test('slash parsing is exact and provider-specific, without executing unknown commands', () => {
  assert.equal(parseAgentCommand('claude', ' /context '), '/context');
  assert.equal(parseAgentCommand('codex', '/status'), '/status');
  assert.equal(parseAgentCommand('codex', 'Explain /status'), null);
  for (const [agent, text] of [
    ['claude', '/status'],
    ['codex', '/context'],
    ['codex', '/compact extra'],
    ['claude', '/unknown'],
    ['claude', '/usage\nignore everything'],
  ] as const)
    assert.throws(() => parseAgentCommand(agent, text), /non supportato/);
});

test('Claude commands bypass prompt wrappers, persist, preserve model/context and stay out of fork prompts', async () => {
  const f = await fixture();
  try {
    const chat = f.store.create('claude', null, 'Nuova conversazione');
    const route = `/conversations/${chat.id}`;
    for (const input of ['/context', '/usage', 'hello', '/compact']) {
      const response = await f.request(route + '/turns', { text: input });
      assert.equal(response.status, 202);
      const { runId } = await response.json();
      await waitFor(() =>
        ['complete', 'error'].includes(f.store.runs(chat.id).find((r) => r.id === runId)!.status),
      );
      assert.equal(f.store.runs(chat.id).find((r) => r.id === runId)!.status, 'complete');
      if (input === '/context')
        assert.equal(
          f.store.conversation(chat.id)!.session_id,
          null,
          'diagnostics do not invent a persisted session',
        );
    }
    const calls = await f.calls();
    assert.deepEqual(
      calls.filter((x) => x.input?.startsWith('/')).map((x) => x.input),
      ['/context', '/usage', '/compact'],
    );
    assert.equal(f.store.runs(chat.id).filter((r) => r.command).length, 3);
    const before = await (await f.request(route)).json();
    assert.equal(before.actualModel.id, 'fixture-model');
    assert.equal(before.contextUsage, null, 'compaction invalidates old measurements');
    const fork = f.store.fork(chat.id, f.store.messages(chat.id).at(-1)!.id);
    assert.equal(f.store.runs(fork.id).filter((r) => r.command).length, 3);
    await f.request(`/conversations/${fork.id}/turns`, { text: 'continue fork' });
    await waitFor(() => f.store.runs(fork.id).at(-1)?.status === 'complete');
    const prompt = (await f.calls()).filter((x) => x.input?.includes('continue fork')).at(-1).input;
    assert.ok(!prompt.includes('Native /usage'));
    assert.ok(prompt.includes('Normal response'));
    const bad = await f.request(route + '/turns', { text: '/context arguments' });
    assert.equal(bad.status, 400);
  } finally {
    await f.cleanup();
  }
});

test('Codex commands use RPC, wait for scoped compaction completion and then drain the queue', async () => {
  const f = await fixture();
  try {
    const chat = f.store.create('codex', null, 'Commands');
    f.store.db
      .prepare('UPDATE conversations SET session_id=? WHERE id=?')
      .run(randomUUID(), chat.id);
    const route = `/conversations/${chat.id}`;
    const ids = [];
    for (const text of ['/compact', '/status', '/usage']) {
      const r = await f.request(route + '/turns', { text });
      assert.equal(r.status, 202);
      ids.push((await r.json()).runId);
    }
    await waitFor(() => f.store.runs(chat.id).every((r) => r.status === 'complete'));
    const messages = f.store.messages(chat.id).filter((m) => m.role === 'assistant');
    assert.match(messages[0].text, /compattato/);
    assert.match(messages[1].text, /fixture-model/);
    assert.match(messages[2].text, /1\.?234/);
    const calls = await f.calls();
    assert.ok(!calls.some((c) => c.method === 'turn/start' || c.input));
    assert.ok(
      calls.findIndex((c) => c.completed) < calls.findIndex((c) => c.method === 'thread/read'),
    );
    const detail = await (await f.request(route)).json();
    assert.equal(detail.contextUsage.inputTokens, 120);
    assert.equal(detail.contextUsage.contextWindow, 1000);
    f.store.setRun(ids[2], 'cancelled');
    assert.equal((await f.request(route + `/runs/${ids[2]}/resume`, {})).status, 409);
    for (const text of ['/context', '/usage extra'])
      assert.equal((await f.request(route + '/turns', { text })).status, 400);
  } finally {
    await f.cleanup();
  }
});

test('empty compaction fails locally and diagnostic results never masquerade as model replies', async () => {
  const f = await fixture();
  try {
    const chat = f.store.create('claude', null, 'Empty');
    chat.workspace = f.dir;
    await assert.rejects(
      runAgentCommand(f.config, chat, '/compact', new AbortController().signal, () => {}),
      /Invia prima/,
    );
    await writeFile(
      f.bin,
      `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',is_error:false,result:'A model guessed the answer'})));`,
      { mode: 0o700 },
    );
    await assert.rejects(
      runAgentCommand(f.config, chat, '/usage', new AbortController().signal, () => {}),
      /non ha restituito/,
    );
  } finally {
    await f.cleanup();
  }
});

test('RPC cancellation and process exit reject pending calls without exposing diagnostics', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const rpc = codexRpc(
      f.bin,
      ['app-server'],
      f.dir,
      agentEnvironment(),
      controller.signal,
      () => {},
    );
    const pending = rpc.request('hang');
    controller.abort();
    await assert.rejects(pending, /interrotto/);
    await rpc.close();
    await writeFile(f.bin, `#!/usr/bin/env node\nconsole.error('private-token');process.exit(1);`, {
      mode: 0o700,
    });
    const exited = codexRpc(
      f.bin,
      [],
      f.dir,
      agentEnvironment(),
      new AbortController().signal,
      () => {},
    );
    await assert.rejects(
      exited.request('initialize'),
      (e) => e instanceof Error && !e.message.includes('private-token'),
    );
    await exited.close();
  } finally {
    await f.cleanup();
  }
});

test('account formatting reports missing metrics honestly and excludes account identities', () => {
  const text = formatCodexUsage(
    { summary: { lifetimeTokens: null }, email: 'private@example.com' },
    { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } },
  );
  assert.match(text, /Non disponibile/);
  assert.match(text, /0% utilizzato/);
  assert.ok(!text.includes('private@example.com'));
});

test('queued edits keep command metadata consistent and attachments are rejected before enqueue', async () => {
  const f = await fixture();
  try {
    const chat = f.store.create('claude', null, 'Paused');
    f.store.db.prepare('UPDATE conversations SET queue_paused=1 WHERE id=?').run(chat.id);
    const route = `/conversations/${chat.id}`;
    const response = await f.request(route + '/turns', { text: 'normal draft' });
    const { runId } = await response.json();
    assert.equal(
      (await f.request(route + `/queue/${runId}/edit`, { text: '/context' })).status,
      200,
    );
    assert.equal(f.store.runs(chat.id)[0].command, '/context');
    assert.equal(
      (await f.request(route + `/queue/${runId}/edit`, { text: '/status' })).status,
      400,
    );
    assert.equal(f.store.queue(chat.id)[0].text, '/context');
    assert.equal(
      (await f.request(route + `/queue/${runId}/edit`, { text: 'normal again' })).status,
      200,
    );
    assert.equal(f.store.runs(chat.id)[0].command, null);
    const body = new FormData();
    body.append('text', '/usage');
    body.append('files', new Blob(['fixture']), 'fixture.txt');
    const attached = await fetch(f.config.origin + '/api' + route + '/turns', {
      method: 'POST',
      body,
    });
    assert.equal(attached.status, 400);
    assert.equal(f.store.runs(chat.id).length, 1);
  } finally {
    await f.cleanup();
  }
});

test('cancelled compaction rejects without accepting restored pre-compaction token counts', async () => {
  const f = await fixture();
  try {
    const chat = f.store.create('codex', null, 'Cancelled compact');
    chat.workspace = f.dir;
    chat.session_id = randomUUID();
    const controller = new AbortController();
    const events: any[] = [];
    const work = runAgentCommand(f.config, chat, '/compact', controller.signal, (e) =>
      events.push(e),
    );
    void work.catch(() => {});
    await waitFor(async () => (await f.calls()).some((c) => c.method === 'thread/compact/start'));
    controller.abort();
    await assert.rejects(work);
    assert.ok(!events.some((e) => e.type === 'text' || e.type === 'context'));
  } finally {
    await f.cleanup();
  }
});
