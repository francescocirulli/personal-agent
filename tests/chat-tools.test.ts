import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store';
import { SkillService } from '../server/skills';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';

const content = (name: string) =>
  `---\nname: ${name}\ndescription: Skill di prova.\n---\nIstruzioni.\n`;

test('chat selections persist, inherit on legacy chats and forks, and respect global skill availability', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-chat-tools-'));
  let store = new Store(dir);
  const accesses: Awaited<ReturnType<SkillService['access']>>[] = [];
  try {
    let skills = new SkillService(store, dir, () => {});
    const a = skills.save({ content: content('prima'), agents: ['codex', 'claude'] });
    const b = skills.save({ content: content('seconda'), agents: ['claude'] });
    const inherited = store.create('codex', null, 'Globali');
    store.db.prepare('UPDATE conversations SET tools=NULL WHERE id=?').run(inherited.id);
    assert.deepEqual(store.conversation(inherited.id)!.tools, { mcp: null, skills: null });
    const custom = store.create('codex', null, 'Personalizzata', { mcp: [], skills: [a.id, b.id] });
    const none = store.create('codex', null, 'Nessuna', { mcp: [], skills: [] });
    const names = async (id: string) => {
      const access = await skills.access(store.conversation(id)!, randomUUID());
      accesses.push(access);
      return access.instructions;
    };
    assert.match(await names(custom.id), /"name":"prima"/);
    assert.doesNotMatch(await names(custom.id), /"name":"seconda"/);
    assert.doesNotMatch(await names(none.id), /"name":"prima"/);
    skills.setEnabled(a.id, false);
    // Editing the content must not silently re-enable a globally disabled skill.
    skills.save({ content: content('prima'), agents: ['codex', 'claude'] }, a.id);
    assert.doesNotMatch(await names(custom.id), /"name":"prima"/);
    assert.doesNotMatch(await names(inherited.id), /"name":"prima"/);
    skills.setEnabled(a.id, true);
    skills.save({ content: content('nuova'), agents: ['codex'] });
    assert.match(await names(custom.id), /"name":"prima"/);
    assert.doesNotMatch(await names(custom.id), /"name":"nuova"/);
    assert.match(await names(inherited.id), /"name":"nuova"/);
    const run = store.enqueue(custom.id, 'Prova', []);
    store.setRun(run, 'complete');
    const answer = store.addMessage(custom.id, run, 'assistant', 'Risposta');
    const fork = store.fork(custom.id, answer.id);
    assert.deepEqual(fork.tools, custom.tools);
    store.close();
    store = new Store(dir);
    skills = new SkillService(store, dir, () => {});
    assert.deepEqual(store.conversation(custom.id)!.tools, custom.tools);
    assert.deepEqual(store.list().find((c) => c.id === none.id)!.tools, none.tools);
    assert.match(await names(custom.id), /"name":"prima"/);
  } finally {
    await Promise.all(accesses.map((a) => a.release()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('API stores chat tools; MCP grants exclude unselected/disabled connections and expire with the turn', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-chat-tools-api-'));
  const ids = [randomUUID(), randomUUID()];
  await mkdir(path.join(dir, 'mcp'));
  await writeFile(
    path.join(dir, 'mcp/connections.json'),
    JSON.stringify(
      ids.map((id, i) => ({
        id,
        name: `fixture-${i}`,
        url: 'https://example.org/mcp',
        mode: 'automatic',
        status: 'connected',
        secret: `old-secret-${i}`,
      })),
    ),
  );
  const config = {
    ...readConfig(),
    dataDir: dir,
    demo: true,
    password: '',
    vapidPublic: '',
    vapidPrivate: '',
  };
  const runtime = createApp(config);
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  config.port = (server.address() as { port: number }).port;
  config.origin = `http://127.0.0.1:${config.port}`;
  const request = (endpoint: string, body?: unknown) =>
    fetch(config.origin + '/api' + endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal(
      (await request('/conversations', { agent: 'codex', tools: { mcp: 'all' } })).status,
      400,
    );
    assert.equal(
      (await request('/conversations', { agent: 'codex', tools: { skills: ['invalid'] } })).status,
      400,
    );
    const response = await request('/conversations', {
      agent: 'codex',
      tools: { mcp: [ids[0]], skills: [] },
    });
    assert.equal(response.status, 201);
    const chat = await response.json();
    assert.deepEqual(chat.tools, { mcp: [ids[0]], skills: [] });
    assert.deepEqual((await (await request(`/conversations/${chat.id}`)).json()).tools, chat.tools);
    const custom = runtime.mcp.access(chat.id, chat.tools.mcp);
    assert.equal(custom.servers.length, 1);
    assert.equal(custom.servers[0].name, 'pa_fixture-0');
    const summary = () => request(`/conversations/${chat.id}/tools`).then((r) => r.json());
    let view = await summary();
    assert.equal(view.conversationId, chat.id);
    assert.deepEqual(view.selection, chat.tools);
    assert.deepEqual(
      view.mcp.filter((item: any) => item.available).map((item: any) => `pa_${item.name}`),
      custom.servers.map((item) => item.name),
    );
    assert.equal(view.mcp[1].reason, 'Escluso da questa chat');
    assert.doesNotMatch(JSON.stringify(view), /old-secret|access_token|code_verifier/);
    assert.equal((await request(`/conversations/${randomUUID()}/tools`)).status, 404);
    assert.equal(runtime.mcp.access('empty', []).servers.length, 0);
    assert.equal(runtime.mcp.access('inherited').servers.length, 2);
    const bearer = custom.env[custom.servers[0].tokenVariable];
    const gateway = (id: string) =>
      fetch(config.origin + '/api/mcp/gateway/' + id, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
    assert.equal((await gateway(ids[1])).status, 401);
    const list = await fetch(config.origin + '/api/mcp/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ action: 'list' }),
    });
    assert.deepEqual(
      (await list.json()).map((c: { selectedForChat: boolean }) => c.selectedForChat),
      [true, false],
    );
    assert.equal((await request(`/mcp/${ids[0]}/enabled`, { enabled: 'false' })).status, 400);
    assert.equal((await request(`/mcp/${ids[0]}/enabled`, { enabled: false })).status, 200);
    assert.equal(runtime.mcp.access('custom-disabled', [ids[0]]).servers.length, 0);
    assert.equal(runtime.mcp.access('global-disabled').servers.length, 1);
    view = await summary();
    assert.equal(view.mcp.filter((item: any) => item.available).length, 0);
    assert.equal(view.mcp[0].selected, true);
    assert.equal(view.mcp[0].reason, 'Disabilitato globalmente');
    assert.equal((await gateway(ids[0])).status, 403);
    await request(`/mcp/${ids[0]}/enabled`, { enabled: true });
    assert.equal(runtime.mcp.access('restored', [ids[0]]).servers.length, 1);
    custom.release();
    assert.equal((await gateway(ids[0])).status, 401);
    const skill = await (
      await request('/skills', { content: content('globale'), agents: ['codex'] })
    ).json();
    assert.equal((await request(`/skills/${skill.id}/enabled`, { enabled: false })).status, 200);
    assert.equal((await (await request(`/skills/${skill.id}`)).json()).enabled, false);
    assert.equal((await request(`/skills/${randomUUID()}/enabled`, { enabled: true })).status, 404);
    const otherSkill = runtime.skills.save({ content: content('solo-claude'), agents: ['claude'] });
    view = await summary();
    assert.ok(view.skills.every((item: any) => !item.available && !item.selected));
    const inherited = runtime.store.create('codex', 'example/project', 'Con progetto');
    const workspace = path.join(dir, 'workspace');
    const folder = path.join(workspace, '.claude/skills/progetto');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'SKILL.md'), content('progetto'));
    runtime.store.db
      .prepare('UPDATE conversations SET workspace=? WHERE id=?')
      .run(workspace, inherited.id);
    const inheritedView = await (await request(`/conversations/${inherited.id}/tools`)).json();
    assert.equal(
      inheritedView.skills.find((item: any) => item.id === skill.id).reason,
      'Disabilitata globalmente',
    );
    assert.equal(
      inheritedView.skills.find((item: any) => item.id === otherSkill.id).reason,
      'Non abilitata per questo agente',
    );
    assert.equal(inheritedView.mcp.filter((item: any) => item.available).length, 2);
    assert.equal(inheritedView.project.ready, true);
    assert.deepEqual(
      inheritedView.project.skills.map((item: any) => item.name),
      ['progetto'],
    );
    const projectAccess = await runtime.skills.access(
      runtime.store.conversation(inherited.id)!,
      randomUUID(),
    );
    try {
      assert.match(projectAccess.instructions, /"name":"progetto"/);
      assert.doesNotMatch(projectAccess.instructions, /"name":"globale"|"name":"solo-claude"/);
    } finally {
      await projectAccess.release();
    }
  } finally {
    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
