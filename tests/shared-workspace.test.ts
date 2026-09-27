import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { prepareWorkspace, sharedWorkspacePath } from '../server/runner';
import { GitService } from '../server/git';
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
    demo: false,
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
    store.db.prepare('UPDATE conversations SET workspace=? WHERE id=?').run(workspace, a.id);
    const view = async (id: string) =>
      (await (await f.request(`/conversations/${id}/git`)).json()) as any;
    assert.equal((await view(a.id)).blocked, null);
    store.enqueue(b.id, 'più tardi', []);
    // Both a new chat and a previously prepared chat reserve the shared branch for queued work.
    for (const otherWorkspace of [null, workspace]) {
      store.db.prepare('UPDATE conversations SET workspace=? WHERE id=?').run(otherWorkspace, b.id);
      assert.match(String((await view(a.id)).blocked), /stessa cartella condivisa/);
      const refused = await f.request(`/conversations/${a.id}/git`, {
        action: 'create',
        name: 'topic',
        base: 'HEAD',
      });
      assert.equal(refused.status, 409);
    }
    assert.equal(await git(workspace, 'symbolic-ref', '--short', 'HEAD'), 'main');
    // Isolated chats are unaffected by other chats.
    const isolated = store.create('claude', 'example/project', 'Solo');
    assert.equal((await view(isolated.id)).blocked, null);
  } finally {
    await f.close();
  }
});

test('shared Git changes block new turns and queue starts until completion, then reset peer sessions', async (t) => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const original = GitService.prototype.change;
  t.mock.method(
    GitService.prototype,
    'change',
    async function (this: GitService, ...args: Parameters<typeof original>) {
      entered();
      await gate;
      return original.apply(this, args);
    },
  );
  try {
    const { store } = f.runtime;
    const a = store.create('codex', 'example/project', 'A', undefined, 'shared');
    const b = store.create('codex', 'example/project', 'B', undefined, 'shared');
    const fresh = store.create('codex', 'example/project', 'New', undefined, 'shared');
    const isolated = store.create('codex', null, 'Independent');
    const workspace = await prepareWorkspace(f.config, a, new AbortController().signal);
    store.db
      .prepare('UPDATE conversations SET workspace=?,session_id=? WHERE id IN (?,?)')
      .run(workspace, 'previous-session', a.id, b.id);
    // Real Git checkout, simulated agents only.
    f.config.demo = true;
    const switching = f.request(`/conversations/${a.id}/git`, {
      action: 'create',
      name: 'topic',
      base: 'HEAD',
    });
    await inside;
    for (const other of [b, fresh]) {
      assert.equal(
        (await f.request(`/conversations/${other.id}/turns`, { text: 'Do not start' })).status,
        409,
      );
      assert.equal(store.runs(other.id).length, 0);
      assert.equal(
        (await f.request(`/conversations/${other.id}/git`, { action: 'prepare' })).status,
        409,
      );
      const runId = store.enqueue(other.id, 'Wait for Git', []);
      // These endpoints also drain the queue and must respect the same reservation.
      assert.equal(
        (await f.request(`/conversations/${other.id}/queue/${runId}/send-now`, {})).status,
        202,
      );
      assert.equal(
        (await f.request(`/conversations/${other.id}/queue/pause`, { paused: false })).status,
        200,
      );
      assert.equal(store.runs(other.id).at(-1)?.status, 'queued');
    }
    assert.equal((await f.request(`/conversations/${b.id}/diff`)).status, 409);
    assert.equal(
      (await f.request(`/conversations/${isolated.id}/turns`, { text: 'Independent work' })).status,
      202,
    );
    assert.equal(store.runs(isolated.id).at(-1)?.status, 'running');
    release();
    assert.equal((await switching).status, 200);
    assert.equal(await git(workspace, 'symbolic-ref', '--short', 'HEAD'), 'topic');
    for (const other of [b, fresh]) assert.notEqual(store.runs(other.id).at(-1)?.status, 'queued');
    assert.notEqual(store.conversation(b.id)?.session_id, 'previous-session');
    assert.equal(store.conversation(a.id)?.session_id, null);
    // The opposite ordering is protected too: running peers block further branch changes.
    assert.equal(
      (
        await f.request(`/conversations/${a.id}/git`, {
          action: 'create',
          name: 'too-soon',
          base: 'HEAD',
        })
      ).status,
      409,
    );
  } finally {
    release();
    await f.close();
  }
});

async function waitForFile(file: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      await readFile(file).then(
        () => true,
        () => false,
      )
    )
      return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for fixture marker: ${path.basename(file)}`);
}

// Gate a real clone of the local remote so cancellation ordering is deterministic.
async function gatedClone(dir: string) {
  const previousPath = process.env.PATH;
  const realGit = (await exec('which', ['git'])).stdout.trim();
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  const started = path.join(bin, 'started');
  const release = path.join(bin, 'release');
  const fail = path.join(bin, 'fail');
  await writeFile(
    path.join(bin, 'git'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const marker = name => path.join(__dirname, name);
const run = () => {
  if (fs.existsSync(marker('fail'))) process.exit(1);
  const child = spawn(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio: 'inherit'});
  child.on('exit', code => process.exit(code ?? 1));
};
if (process.argv[2] === 'clone') {
  fs.appendFileSync(marker('started'), 'clone\\n');
  const timer = setInterval(() => {
    if (fs.existsSync(marker('release'))) { clearInterval(timer); run(); }
  }, 10);
} else run();
`,
    { mode: 0o700 },
  );
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  return {
    started,
    release,
    fail,
    restore() {
      process.env.PATH = previousPath;
    },
  };
}

for (const cancelledIndex of [0, 1])
  test(`cancelling shared clone waiter ${cancelledIndex + 1} leaves the other chat running`, async () => {
    const f = await fixture();
    const gate = await gatedClone(f.dir);
    const controllers = [new AbortController(), new AbortController()];
    try {
      const chats = controllers.map((_, i) =>
        f.runtime.store.create('codex', 'example/project', String(i), undefined, 'shared'),
      );
      const results = chats.map((chat, i) =>
        prepareWorkspace(f.config, chat, controllers[i].signal).then(
          (value) => ({ value, cancelled: false }),
          () => ({ value: '', cancelled: true }),
        ),
      );
      await waitForFile(gate.started);
      controllers[cancelledIndex].abort();
      const cancelled = await Promise.race([results[cancelledIndex], delay(1000).then(() => null)]);
      assert.deepEqual(cancelled, { value: '', cancelled: true });
      assert.equal(controllers[1 - cancelledIndex].signal.aborted, false);
      await writeFile(gate.release, 'go');
      const survivor = await results[1 - cancelledIndex];
      assert.equal(survivor.cancelled, false);
      assert.equal(survivor.value, sharedWorkspacePath(f.config, 'example/project'));
      assert.equal(await readFile(gate.started, 'utf8'), 'clone\n');
      assert.deepEqual(await readdir(path.dirname(survivor.value)), ['project']);
    } finally {
      controllers.forEach((controller) => controller.abort());
      gate.restore();
      await f.close();
    }
  });

test('abandoning all shared clone waiters cleans staging and permits a fresh retry', async () => {
  const f = await fixture();
  const gate = await gatedClone(f.dir);
  const controllers = [new AbortController(), new AbortController()];
  try {
    const chat = f.runtime.store.create('codex', 'example/project', 'A', undefined, 'shared');
    const results = Promise.allSettled(
      controllers.map((controller) => prepareWorkspace(f.config, chat, controller.signal)),
    );
    await waitForFile(gate.started);
    controllers.forEach((controller) => controller.abort());
    const cancelled = await Promise.race([results, delay(3000).then(() => null)]);
    assert.deepEqual(
      cancelled?.map((result) => result.status),
      ['rejected', 'rejected'],
    );
    const workspace = sharedWorkspacePath(f.config, chat.repo!);
    assert.deepEqual(await readdir(path.dirname(workspace)), []);
    await writeFile(gate.release, 'go');
    assert.equal(await prepareWorkspace(f.config, chat, new AbortController().signal), workspace);
    assert.equal(await readFile(gate.started, 'utf8'), 'clone\nclone\n');
    assert.deepEqual(await readdir(path.dirname(workspace)), ['project']);
  } finally {
    controllers.forEach((controller) => controller.abort());
    gate.restore();
    await f.close();
  }
});

test('failed shared clones reject all waiters, remove staging, and allow retry', async () => {
  const f = await fixture();
  const gate = await gatedClone(f.dir);
  try {
    const chat = f.runtime.store.create('codex', 'example/project', 'A', undefined, 'shared');
    await writeFile(gate.fail, 'fail');
    const results = Promise.allSettled(
      [0, 1].map(() => prepareWorkspace(f.config, chat, new AbortController().signal)),
    );
    await waitForFile(gate.started);
    await writeFile(gate.release, 'go');
    assert.deepEqual(
      (await results).map((result) => result.status),
      ['rejected', 'rejected'],
    );
    const workspace = sharedWorkspacePath(f.config, chat.repo!);
    assert.deepEqual(await readdir(path.dirname(workspace)), []);
    await rm(gate.fail);
    assert.equal(await prepareWorkspace(f.config, chat, new AbortController().signal), workspace);
    assert.equal(await readFile(gate.started, 'utf8'), 'clone\nclone\n');
  } finally {
    gate.restore();
    await f.close();
  }
});
