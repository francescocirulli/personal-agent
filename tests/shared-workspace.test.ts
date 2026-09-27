import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { prepareWorkspace, sharedWorkspacePath } from '../server/runner';
const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec('git', args, { cwd })).stdout.trim();
}
// Redirect https://github.com/<owner>/<name>.git to a local bare remote through a temporary HOME.
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-shared-'));
  const seed = path.join(dir, 'seed'),
    remotes = path.join(dir, 'remotes'),
    home = path.join(dir, 'home');
  await mkdir(seed);
  await mkdir(path.join(remotes, 'example'), { recursive: true });
  await mkdir(home);
  await git(seed, 'init', '-b', 'main');
  await git(seed, 'config', 'user.email', 'test@example.invalid');
  await git(seed, 'config', 'user.name', 'Test');
  await writeFile(path.join(seed, 'README.md'), 'hello\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'Initial');
  await git(dir, 'clone', '--bare', seed, path.join(remotes, 'example', 'project.git'));
  await writeFile(
    path.join(home, '.gitconfig'),
    `[url "file://${remotes}/"]\n\tinsteadOf = https://github.com/\n`,
  );
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const config = {
    ...readConfig(),
    dataDir: path.join(dir, 'data'),
    password: 'shared-test-long-password-24',
    vapidPublic: '',
    vapidPrivate: '',
  };
  const runtime = createApp(config);
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  config.port = (server.address() as any).port;
  config.origin = `http://127.0.0.1:${config.port}`;
  let cookie = '';
  const request = (route: string, body?: unknown) =>
    fetch(config.origin + '/api' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  cookie = (await request('/login', { password: config.password })).headers
    .get('set-cookie')!
    .split(';')[0];
  return {
    dir,
    config,
    runtime,
    request,
    async close() {
      await runtime.close();
      await new Promise<void>((r) => server.close(() => r()));
      process.env.HOME = previousHome;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('shared chats reuse one checkout without agent branches; isolated chats keep their own clone', async () => {
  const f = await fixture();
  try {
    const { store } = f.runtime;
    const a = store.create('claude', 'example/project', 'A', undefined, 'shared');
    const b = store.create('claude', 'example/project', 'B', undefined, 'shared');
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      prepareWorkspace(f.config, a, signal),
      prepareWorkspace(f.config, b, signal),
    ]);
    const expected = sharedWorkspacePath(f.config, 'example/project');
    assert.equal(first, expected);
    assert.equal(second, expected);
    assert.equal(await git(first, 'symbolic-ref', '--short', 'HEAD'), 'main');
    // No leftover staging directories from the serialized clone.
    assert.deepEqual(await readdir(path.dirname(expected)), ['project']);
    // Later chats reuse the checkout as it is, including local work.
    await writeFile(path.join(expected, 'notes.md'), 'work in progress\n');
    const c = store.create('claude', 'example/project', 'C', undefined, 'shared');
    assert.equal(await prepareWorkspace(f.config, c, signal), expected);
    assert.equal(await git(expected, 'status', '--porcelain'), '?? notes.md');

    const isolated = store.create('claude', 'example/project', 'D');
    assert.equal(isolated.workspace_mode, 'isolated');
    const own = await prepareWorkspace(f.config, isolated, signal);
    assert.equal(own, path.join(f.config.dataDir, 'workspaces', isolated.id));
    assert.equal(
      await git(own, 'symbolic-ref', '--short', 'HEAD'),
      `agent/${isolated.id.slice(0, 8)}`,
    );
  } finally {
    await f.close();
  }
});

test('free chats and forks: mode applies to repositories only and forks inherit it', async () => {
  const f = await fixture();
  try {
    const { store } = f.runtime;
    assert.equal(
      store.create('claude', null, 'Free', undefined, 'shared').workspace_mode,
      'isolated',
    );
    const chat = store.create('claude', 'example/project', 'Shared', undefined, 'shared');
    const runId = randomUUID();
    store.db
      .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)')
      .run(runId, chat.id, 'complete', null, 1, 1);
    store.addMessage(chat.id, runId, 'user', 'ciao', '');
    const reply = store.addMessage(chat.id, runId, 'assistant', 'ciao!', '');
    assert.equal(store.fork(chat.id, reply.id).workspace_mode, 'shared');
  } finally {
    await f.close();
  }
});

test('branch changes in a shared checkout wait for every chat using it', async () => {
  const f = await fixture();
  try {
    const { store } = f.runtime;
    const workspace = sharedWorkspacePath(f.config, 'example/project');
    const a = store.create('claude', 'example/project', 'A', undefined, 'shared');
    const b = store.create('claude', 'example/project', 'B', undefined, 'shared');
    await prepareWorkspace(f.config, a, new AbortController().signal);
    store.db
      .prepare('UPDATE conversations SET workspace=? WHERE id IN (?,?)')
      .run(workspace, a.id, b.id);
    const view = async (id: string) =>
      (await (await f.request(`/conversations/${id}/git`)).json()) as any;
    assert.equal((await view(a.id)).blocked, null);
    store.enqueue(b.id, 'più tardi', []);
    assert.match(String((await view(a.id)).blocked), /stessa cartella condivisa/);
    const refused = await f.request(`/conversations/${a.id}/git`, {
      action: 'create',
      name: 'topic',
      base: 'HEAD',
    });
    assert.equal(refused.status, 409);
    assert.equal(await git(workspace, 'symbolic-ref', '--short', 'HEAD'), 'main');
    // Isolated chats are unaffected by other chats.
    const isolated = store.create('claude', 'example/project', 'Solo');
    assert.equal((await view(isolated.id)).blocked, null);
  } finally {
    await f.close();
  }
});
