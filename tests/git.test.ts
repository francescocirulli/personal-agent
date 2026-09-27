import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec('git', args, { cwd })).stdout.trim();
}
async function fixture(demo = false) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-git-'));
  const seed = path.join(dir, 'seed'),
    remote = path.join(dir, 'remote.git'),
    workspace = path.join(dir, 'checkout');
  await mkdir(seed);
  await git(seed, 'init', '-b', 'main');
  await git(seed, 'config', 'user.email', 'test@example.invalid');
  await git(seed, 'config', 'user.name', 'Test');
  await writeFile(path.join(seed, 'README.md'), 'main contents');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'Initial');
  await git(dir, 'clone', '--bare', seed, remote);
  await git(dir, 'clone', remote, workspace);
  await git(seed, 'switch', '-c', 'remote-topic');
  await writeFile(path.join(seed, 'README.md'), 'remote contents');
  await git(seed, 'commit', '-am', 'Remote');
  await git(seed, 'push', remote, 'remote-topic');
  const bin = path.join(dir, 'agent.cjs');
  await writeFile(
    bin,
    `#!/usr/bin/env node
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>setTimeout(()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Finito'}})),2000));`,
    { mode: 0o700 },
  );
  const config = {
    ...readConfig(),
    dataDir: dir,
    demo,
    codexBin: bin,
    password: 'git-test-long-password-24',
    vapidPublic: '',
    vapidPrivate: '',
  };
  let runtime = createApp(config),
    server = runtime.app.listen(0, '127.0.0.1');
  async function listen() {
    await new Promise<void>((r) => server.once('listening', r));
    config.port = (server.address() as any).port;
    config.origin = `http://127.0.0.1:${config.port}`;
  }
  await listen();
  let cookie = '';
  const request = (route: string, body?: unknown, auth = true) =>
    fetch(config.origin + '/api' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(auth ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  cookie = (await request('/login', { password: config.password })).headers
    .get('set-cookie')!
    .split(';')[0];
  const chat = runtime.store.create('codex', 'example/project', 'Git test');
  runtime.store.db
    .prepare('UPDATE conversations SET workspace=?,session_id=? WHERE id=?')
    .run(workspace, 'old-session', chat.id);
  return {
    dir,
    workspace,
    remote,
    seed,
    chat,
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

test('Git API: actual branch, fetch, remote tracking, create from chosen base, persistence and isolated chats', async () => {
  const f = await fixture();
  try {
    const base = `/conversations/${f.chat.id}/git`;
    assert.equal((await f.request(base, undefined, false)).status, 401);
    assert.equal(
      (await f.request(base, { action: 'create', name: 'bad', base: 'HEAD' }, false)).status,
      401,
    );
    let state = await (await f.request(base)).json();
    assert.equal(state.branch, 'main');
    assert.equal(state.changedFiles, 0);
    assert.ok(!state.branches.some((b: any) => b.name === 'origin/remote-topic'));
    assert.equal((await f.request(base, { action: 'fetch' })).status, 200);
    assert.equal(await readFile(path.join(f.workspace, 'README.md'), 'utf8'), 'main contents');
    state = await (await f.request(base)).json();
    assert.ok(state.branches.some((b: any) => b.name === 'origin/remote-topic'));
    const other = f.store.create('codex', 'example/project', 'Other');
    const otherDir = path.join(f.dir, 'other');
    await git(f.dir, 'clone', f.remote, otherDir);
    f.store.db.prepare('UPDATE conversations SET workspace=? WHERE id=?').run(otherDir, other.id);
    assert.equal(
      (await f.request(base, { action: 'switch', branch: 'refs/remotes/origin/remote-topic' }))
        .status,
      200,
    );
    assert.equal(await git(f.workspace, 'symbolic-ref', '--short', 'HEAD'), 'remote-topic');
    assert.equal(
      await git(f.workspace, 'rev-parse', '--abbrev-ref', '@{upstream}'),
      'origin/remote-topic',
    );
    assert.equal(await readFile(path.join(f.workspace, 'README.md'), 'utf8'), 'remote contents');
    assert.equal(await git(otherDir, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(f.store.conversation(f.chat.id)!.session_id, null);
    assert.equal(
      (await f.request(base, { action: 'create', name: 'feature/mobile', base: 'refs/heads/main' }))
        .status,
      200,
    );
    assert.equal(await readFile(path.join(f.workspace, 'README.md'), 'utf8'), 'main contents');
    assert.equal(await git(f.dir, 'ls-remote', f.remote, 'refs/heads/feature/mobile'), '');
    await f.restart();
    state = await (await f.request(base)).json();
    assert.equal(state.branch, 'feature/mobile');
    await git(f.workspace, 'switch', 'main');
    state = await (await f.request(base)).json();
    assert.equal(state.branch, 'main');
    await git(f.workspace, 'switch', '--detach', 'HEAD');
    state = await (await f.request(base)).json();
    assert.equal(state.detached, true);
    assert.equal(state.branch, null);
    assert.equal(
      (await f.request(base, { action: 'create', name: 'recovered', base: 'HEAD' })).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test('Git changes reject dirty files, invalid refs, duplicates, active runs and paused queues without data loss', async () => {
  const f = await fixture();
  try {
    const base = `/conversations/${f.chat.id}`,
      route = base + '/git';
    for (const name of ['-bad', 'HEAD', 'bad name', 'a..b', 'refs/heads/../bad', 'x\nbranch'])
      assert.equal((await f.request(route, { action: 'create', name, base: 'HEAD' })).status, 400);
    assert.equal(
      (await f.request(route, { action: 'create', name: 'main', base: 'HEAD' })).status,
      409,
    );
    assert.equal((await f.request(route, { action: 'switch', branch: '--force' })).status, 409);
    assert.equal(
      (await f.request(route, { action: 'create', name: 'fine', base: '--orphan' })).status,
      409,
    );
    const extra = path.join(f.workspace, 'draft.txt');
    await writeFile(extra, 'keep me');
    assert.equal((await (await f.request(route)).json()).changedFiles, 1);
    assert.equal(
      (await f.request(route, { action: 'create', name: 'blocked', base: 'HEAD' })).status,
      409,
    );
    assert.equal(await readFile(extra, 'utf8'), 'keep me');
    await rm(extra);
    await writeFile(path.join(f.workspace, 'README.md'), 'local edits');
    await git(f.workspace, 'add', 'README.md');
    assert.equal(
      (await f.request(route, { action: 'switch', branch: 'refs/heads/main' })).status,
      409,
    );
    assert.equal(await readFile(path.join(f.workspace, 'README.md'), 'utf8'), 'local edits');
    await git(f.workspace, 'reset', '--hard', 'HEAD');
    await f.request(base + '/queue/pause', { paused: true });
    const queued = await (await f.request(base + '/turns', { text: 'Pending' })).json();
    assert.equal(
      (await f.request(route, { action: 'create', name: 'blocked', base: 'HEAD' })).status,
      409,
    );
    assert.match((await (await f.request(route)).json()).blocked, /coda/);
    await f.request(base + `/queue/${queued.runId}/delete`, {});
    await f.request(base + '/queue/pause', { paused: false });
    await f.request(base + '/turns', { text: 'Slow work' });
    assert.equal(
      (await f.request(route, { action: 'switch', branch: 'refs/heads/main' })).status,
      409,
    );
    assert.match((await (await f.request(route)).json()).blocked, /task/);
    await f.request(base + '/cancel', {});
    // Cancellation is recorded before asynchronous resource cleanup releases the chat.
    for (let i = 0; i < 100 && (await (await f.request(route)).json()).blocked; i++)
      await delay(25);
    assert.equal((await (await f.request(route)).json()).blocked, null);
    const count = f.store.messages(f.chat.id).length;
    assert.equal(
      (await f.request(route, { action: 'create', name: 'ready', base: 'HEAD' })).status,
      200,
    );
    assert.equal(f.store.messages(f.chat.id).length, count);
  } finally {
    await f.close();
  }
});

test('Git operation reserves the chat until completion: no overlapping switch, run or deletion', async () => {
  const f = await fixture();
  try {
    const script = path.join(f.dir, 'slow-upload.sh'),
      marker = path.join(f.dir, 'fetch-started');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nsleep 1\nexec git-upload-pack "$@"\n`, {
      mode: 0o700,
    });
    await git(f.workspace, 'config', 'remote.origin.uploadpack', script);
    const base = `/conversations/${f.chat.id}`;
    const fetching = f.request(base + '/git', { action: 'fetch' });
    for (let i = 0; i < 100; i++) {
      if (
        await readFile(marker)
          .then(() => true)
          .catch(() => false)
      )
        break;
      await delay(10);
    }
    assert.equal(
      (await f.request(base + '/git', { action: 'create', name: 'race', base: 'HEAD' })).status,
      409,
    );
    assert.equal((await f.request(base + '/turns', { text: 'Do not start' })).status, 409);
    assert.equal((await f.request(base + '/delete', {})).status, 409);
    assert.equal((await fetching).status, 200);
    assert.equal(
      (await f.request(base + '/git', { action: 'create', name: 'after', base: 'HEAD' })).status,
      200,
    );
    assert.equal(f.store.runs(f.chat.id).length, 0);
  } finally {
    await f.close();
  }
});

test('prepare demo repository before first task; free chats do not inherit a parent repository', async () => {
  const f = await fixture(true);
  try {
    const chat = f.store.create('codex', 'example/new-project', 'New');
    const base = `/conversations/${chat.id}/git`;
    assert.equal((await (await f.request(base)).json()).ready, false);
    assert.equal((await f.request(base, { action: 'prepare' })).status, 200);
    const state = await (await f.request(base)).json();
    assert.equal(state.branch, `agent/${chat.id.slice(0, 8)}`);
    const free = f.store.create('codex', null, 'Free');
    assert.equal(
      (await f.request(`/conversations/${free.id}/git`, { action: 'prepare' })).status,
      400,
    );
    const nested = path.join(f.workspace, 'nested');
    await mkdir(nested);
    f.store.db.prepare('UPDATE conversations SET workspace=? WHERE id=?').run(nested, free.id);
    assert.equal((await f.request(`/conversations/${free.id}/git`)).status, 409);
  } finally {
    await f.close();
  }
});

test('diffs include staged, unstaged, new, deleted and renamed files; branch comparison survives commits', async () => {
  const f = await fixture();
  try {
    const route = `/conversations/${f.chat.id}/diff`;
    assert.equal((await f.request(route, undefined, false)).status, 401);
    await git(f.workspace, 'config', 'user.email', 'test@example.invalid');
    await git(f.workspace, 'config', 'user.name', 'Test');
    await git(f.workspace, 'switch', '-c', 'review');
    await writeFile(path.join(f.workspace, 'remove.txt'), 'to remove\n');
    await writeFile(path.join(f.workspace, 'rename.txt'), 'renamed content\n');
    await git(f.workspace, 'add', '.');
    await git(f.workspace, 'commit', '-m', 'Fixtures');
    await writeFile(path.join(f.workspace, 'README.md'), 'staged content\n');
    await git(f.workspace, 'add', 'README.md');
    await writeFile(path.join(f.workspace, 'README.md'), 'staged content\nworking copy\n');
    await git(f.workspace, 'mv', 'rename.txt', 'renamed.txt');
    await rm(path.join(f.workspace, 'remove.txt'));
    await writeFile(path.join(f.workspace, 'new file.txt'), 'new content\n');
    const before = await git(f.workspace, 'status', '--porcelain');
    const state = await (await f.request(route)).json();
    assert.equal(state.total, 4);
    assert.equal(state.files.find((x: any) => x.path === 'renamed.txt').previousPath, 'rename.txt');
    assert.equal(state.files.find((x: any) => x.path === 'remove.txt').status, 'D');
    const diff = await (await f.request(route + '?file=README.md')).json();
    assert.match(diff.patch, /-main contents/);
    assert.match(diff.patch, /\+staged content/);
    assert.match(diff.patch, /\+working copy/);
    assert.match(
      (await (await f.request(route + '?file=new%20file.txt')).json()).patch,
      /\+new content/,
    );
    assert.match(
      (await (await f.request(route + '?file=renamed.txt')).json()).patch,
      /rename from rename.txt/,
    );
    assert.match((await (await f.request(route + '?file=remove.txt')).json()).patch, /-to remove/);
    assert.equal(await git(f.workspace, 'status', '--porcelain'), before);
    await git(f.workspace, 'add', '-A');
    await git(f.workspace, 'commit', '-m', 'Reviewed work');
    assert.equal((await (await f.request(route)).json()).total, 0);
    const branch = await (await f.request(route + '?mode=branch&base=refs/heads/main')).json();
    assert.equal(branch.base, 'refs/heads/main');
    assert.ok(branch.files.some((x: any) => x.path === 'README.md'));
    assert.match(
      (await (await f.request(route + '?mode=branch&base=refs/heads/main&file=README.md')).json())
        .patch,
      /\+working copy/,
    );
    assert.equal((await f.request(route + '?mode=branch&base=--output=/tmp/unsafe')).status, 409);
    assert.equal((await f.request(route + '?file=../../etc/passwd')).status, 404);
    assert.equal((await f.request(route + '?file=.git/config')).status, 404);
    assert.equal((await f.request(route + '?mode=invalid')).status, 400);
    await f.restart();
    assert.ok((await (await f.request(route + '?mode=branch&base=refs/heads/main')).json()).total);
    const other = f.store.create('codex', 'example/project', 'Other checkout');
    assert.equal(
      (await (await f.request(`/conversations/${other.id}/diff`)).json()).git.ready,
      false,
    );
    assert.equal((await f.request(`/conversations/${other.id}/diff?file=README.md`)).status, 404);
  } finally {
    await f.close();
  }
});

test('diffs handle binary/large files, symlinks, literal unusual paths and unborn HEAD', async () => {
  const f = await fixture();
  try {
    const route = `/conversations/${f.chat.id}/diff`;
    const file = async (name: string) =>
      (await f.request(route + '?file=' + encodeURIComponent(name))).json();
    await writeFile(path.join(f.workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
    assert.equal((await file('binary.bin')).binary, true);
    await writeFile(path.join(f.workspace, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    assert.equal((await file('large.txt')).limited, true);
    await writeFile(path.join(f.workspace, 'preview.txt'), 'x\n'.repeat(70000));
    assert.ok((await file('preview.txt')).patch.length <= 200000);
    assert.equal((await file('preview.txt')).patch.split('\n').length, 5000);
    assert.equal((await file('preview.txt')).limited, true);
    const outside = path.join(f.dir, 'private.txt');
    await writeFile(outside, 'outside-secret');
    await symlink(outside, path.join(f.workspace, 'link'));
    const link = await file('link');
    assert.doesNotMatch(link.patch, /outside-secret/);
    assert.match(link.patch, /private.txt/);
    for (const name of [
      '[literal].txt',
      'line\nbreak.txt',
      'trailing .txt',
      '-option.txt',
      'accento-è.txt',
    ]) {
      await writeFile(path.join(f.workspace, name), 'literal content\n');
      assert.match((await file(name)).patch, /\+literal content/);
    }
    assert.equal((await f.request(route + '?file=' + encodeURIComponent(':(glob)*'))).status, 404);
    // Git text conversion must never execute when a file is reviewed.
    const marker = path.join(f.dir, 'textconv-executed');
    const script = path.join(f.dir, 'textconv.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\necho converted\n`, { mode: 0o700 });
    await writeFile(path.join(f.workspace, '.gitattributes'), 'README.md diff=unsafe\n');
    await git(f.workspace, 'config', 'diff.unsafe.textconv', script);
    await git(f.workspace, 'config', 'diff.external', script);
    await writeFile(path.join(f.workspace, 'README.md'), 'review safe\n');
    assert.match((await file('README.md')).patch, /review safe/);
    await assert.rejects(readFile(marker));
    const newChat = f.store.create('codex', null, 'Unborn');
    const newWorkspace = path.join(f.dir, 'unborn');
    await mkdir(newWorkspace);
    await git(newWorkspace, 'init', '-b', 'main');
    f.store.db
      .prepare('UPDATE conversations SET workspace=? WHERE id=?')
      .run(newWorkspace, newChat.id);
    await writeFile(path.join(newWorkspace, 'first.txt'), 'first\n');
    await git(newWorkspace, 'add', '.');
    const unborn = `/conversations/${newChat.id}/diff`;
    assert.equal((await (await f.request(unborn)).json()).total, 1);
    assert.match((await (await f.request(unborn + '?file=first.txt')).json()).patch, /\+first/);
  } finally {
    await f.close();
  }
});

test('staged edits cancelled in the working tree remain reviewable without mutating the index', async () => {
  const f = await fixture();
  try {
    const route = `/conversations/${f.chat.id}/diff`;
    await writeFile(path.join(f.workspace, 'README.md'), 'staged-only\n');
    await git(f.workspace, 'add', 'README.md');
    await writeFile(path.join(f.workspace, 'README.md'), 'main contents');
    const state = await (await f.request(route)).json();
    assert.equal(state.files[0].indexOnly, true);
    const diff = await (await f.request(route + '?file=README.md')).json();
    assert.match(diff.patch, /\+staged-only/);
    assert.match(diff.note, /copia di lavoro le annulla/);
    assert.equal(await git(f.workspace, 'show', ':README.md'), 'staged-only');
    assert.equal(await readFile(path.join(f.workspace, 'README.md'), 'utf8'), 'main contents');
  } finally {
    await f.close();
  }
});
