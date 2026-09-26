import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store';
import { SkillService } from '../server/skills';
import { skillPromptFor } from '../server/runner';
import { readConfig } from '../server/config';
import { createApp } from '../server/app';

const md = (name: string, body = 'Istruzioni di prova') =>
  `---\nname: ${name}\ndescription: >-\n  Usa questa skill per la verifica.\n---\n${body}\n`;
test('skills: assignment, immutable active turn, repo interoperability, persistence and cleanup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-skills-'));
  const store = new Store(dir);
  let changes = 0;
  const service = new SkillService(store, dir, () => changes++);
  const accesses: Awaited<ReturnType<SkillService['access']>>[] = [];
  try {
    const a = service.save({ content: md('solo-claude'), agents: ['claude'] });
    service.save({ content: md('solo-codex'), agents: ['codex'] });
    service.save({ content: md('condivisa'), agents: ['claude', 'codex'] });
    assert.throws(
      () => service.save({ content: md('condivisa'), agents: ['codex'] }),
      /Esiste già/,
    );
    assert.throws(() => service.save({ content: md('vuota'), agents: [] }));
    assert.throws(
      () => service.save({ content: 'not a skill', agents: ['claude'] }),
      /intestazione/,
    );
    assert.throws(
      () => service.save({ content: md('../escape'), agents: ['claude'] }),
      /Intestazione/,
    );
    const chat = store.create('claude', 'example/repo', 'Skills');
    chat.workspace = path.join(dir, 'repo');
    for (const [folder, name] of [
      ['.claude/skills/claude-project', 'claude-project'],
      ['.agents/skills/codex-project', 'codex-project'],
      ['packages/sub/.codex/skills/legacy', 'legacy'],
    ]) {
      const location = path.join(chat.workspace, folder);
      await mkdir(location, { recursive: true });
      await writeFile(path.join(location, 'SKILL.md'), md(name));
      await writeFile(path.join(location, 'reference.txt'), 'Supporting file');
    }
    await mkdir(path.join(chat.workspace, '.agents/skills/broken'), { recursive: true });
    await writeFile(path.join(chat.workspace, '.agents/skills/broken/SKILL.md'), 'invalid');
    const outside = path.join(dir, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'SKILL.md'), md('outside'));
    await symlink(outside, path.join(chat.workspace, '.agents/skills/escape'));
    await mkdir(path.join(chat.workspace, 'node_modules/ignored/.agents/skills/hidden'), {
      recursive: true,
    });
    await writeFile(
      path.join(chat.workspace, 'node_modules/ignored/.agents/skills/hidden/SKILL.md'),
      md('hidden'),
    );
    const project = await service.project(chat);
    assert.equal(project.skills.length, 3);
    assert.equal(project.warnings.length, 2);
    assert.ok(project.skills.every((s) => s.agents.length === 2));
    assert.equal((await service.project({ ...chat, repo: null })).skills.length, 0);
    await assert.rejects(service.projectContent(chat, '../outside/SKILL.md'));
    for (const agent of ['claude', 'codex'] as const) {
      const access = await service.access({ ...chat, agent }, agent);
      accesses.push(access);
      assert.ok(access.instructions.includes(`solo-${agent}`));
      assert.ok(!access.instructions.includes(agent === 'claude' ? 'solo-codex' : 'solo-claude'));
      for (const s of ['claude-project', 'codex-project', 'legacy', 'condivisa'])
        assert.ok(access.instructions.includes(s));
      assert.doesNotMatch(access.instructions, /Supporting file|Istruzioni di prova/);
      const prompt = skillPromptFor('Il task dell’utente', access.instructions);
      assert.ok(prompt.includes('solo-' + agent));
      assert.ok(prompt.endsWith('Il task dell’utente'));
      const file = path.join(dir, 'skill-runs', agent, `solo-${agent}`, 'SKILL.md');
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    service.save({ content: md('solo-claude', 'Versione aggiornata'), agents: ['codex'] }, a.id);
    assert.match(
      await readFile(path.join(dir, 'skill-runs/claude/solo-claude/SKILL.md'), 'utf8'),
      /Istruzioni di prova/,
    );
    const next = await service.access(chat, 'next');
    accesses.push(next);
    assert.ok(!next.instructions.includes('solo-claude'));
    const updated = await service.access({ ...chat, agent: 'codex' }, 'updated');
    accesses.push(updated);
    assert.match(
      await readFile(path.join(dir, 'skill-runs/updated/solo-claude/SKILL.md'), 'utf8'),
      /Versione aggiornata/,
    );
    service.remove(a.id);
    assert.equal(changes, 5);
    const fresh = new SkillService(store, dir, () => {});
    assert.equal(fresh.list().length, 2);
    assert.ok(fresh.list().every((s) => !('content' in s)));
    const file = await service.projectContent(chat, '.claude/skills/claude-project/SKILL.md');
    assert.equal(file.content, md('claude-project'));
    await Promise.all(accesses.map((a) => a.release()));
    await assert.rejects(stat(path.join(dir, 'skill-runs/claude')));
    assert.equal(
      await readFile(path.join(chat.workspace, '.claude/skills/claude-project/SKILL.md'), 'utf8'),
      md('claude-project'),
    );
  } finally {
    await Promise.allSettled(accesses.map((a) => a.release()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('skills API protects mutations, validates input and exposes project files only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-skills-api-'));
  const config = {
    ...readConfig(),
    dataDir: dir,
    demo: true,
    password: 'skills-test-password-24-characters',
    vapidPublic: '',
    vapidPrivate: '',
  };
  const runtime = createApp(config);
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  config.port = (server.address() as any).port;
  config.origin = `http://127.0.0.1:${config.port}`;
  let cookie = '';
  const request = (p: string, body?: unknown) =>
    fetch(config.origin + '/api' + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal((await request('/skills')).status, 401);
    assert.equal(
      (await request('/skills', { content: md('test'), agents: ['claude'] })).status,
      401,
    );
    cookie = (await request('/login', { password: config.password })).headers
      .get('set-cookie')!
      .split(';')[0];
    assert.equal((await request('/skills', { content: md('test'), agents: [] })).status, 400);
    const created = await request('/skills', { content: md('test'), agents: ['claude'] });
    assert.equal(created.status, 201);
    const skill = (await created.json()) as any;
    assert.equal(
      ((await (await request('/skills/' + skill.id)).json()) as any).content,
      md('test'),
    );
    assert.equal(
      (await request('/skills/' + skill.id, { content: md('test'), agents: ['claude', 'codex'] }))
        .status,
      200,
    );
    const chat = runtime.store.create('codex', 'example/repo', 'Project');
    assert.equal(
      ((await (await request(`/conversations/${chat.id}/skills`)).json()) as any).ready,
      false,
    );
    assert.equal(
      (await request(`/conversations/${chat.id}/skills/file?path=../../secret`)).status,
      404,
    );
    assert.equal((await request('/skills/' + skill.id + '/delete', {})).status, 200);
    assert.equal((await request('/skills/' + skill.id)).status, 404);
    assert.deepEqual(await (await request('/skills')).json(), []);
    for (const row of runtime.store.db
      .prepare("SELECT data FROM events WHERE json_extract(data,'$.type')='skills_changed'")
      .all())
      assert.deepEqual(JSON.parse(String(row.data)), { type: 'skills_changed' });
  } finally {
    await runtime.close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
