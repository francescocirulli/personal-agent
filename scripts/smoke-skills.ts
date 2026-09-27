// Explicit live check: uses both CLI subscriptions, isolated fixtures, no GitHub changes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Store } from '../server/store';
import { SkillService } from '../server/skills';
import { readConfig } from '../server/config';
import { runAgent } from '../server/runner';

const dir = await mkdtemp(path.join(tmpdir(), 'pa-skills-live-'));
const store = new Store(dir);
const service = new SkillService(store, dir, () => {});
const config = { ...readConfig(), dataDir: dir, demo: false };
const markers = {
  claude: 'CL_' + randomUUID(),
  codex: 'CX_' + randomUUID(),
  global: 'GL_' + randomUUID(),
};
const md = (name: string, marker: string) =>
  `---\nname: ${name}\ndescription: Usa questa skill per la verifica tecnica delle skill.\n---\nQuando questa skill è richiesta, riporta questo codice esatto: ${marker}. Non modificare alcun file.\n`;
try {
  const global = service.save({ content: md('global-check', markers.global), agents: ['claude'] });
  const chats = [];
  for (const agent of ['claude', 'codex'] as const) {
    const chat = store.create(agent, 'fixture/skills', 'Skill smoke', { mcp: null, skills: null });
    chat.workspace = path.join(dir, agent);
    await mkdir(chat.workspace);
    execFileSync('git', ['init', '--quiet', chat.workspace]);
    for (const [folder, name, marker] of [
      ['.claude/skills/repo-claude', 'repo-claude', markers.claude],
      ['.agents/skills/repo-codex', 'repo-codex', markers.codex],
    ]) {
      const dest = path.join(chat.workspace, folder);
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, 'SKILL.md'), md(name, marker));
    }
    chats.push(chat);
  }
  for (const [index, chat] of [chats[0], chats[1], chats[1]].entries()) {
    if (index === 2)
      service.save(
        { content: md('global-check', markers.global), agents: ['claude', 'codex'] },
        global.id,
      );
    const access = await service.access(chat, randomUUID());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150000);
    let text = '',
      failure = '';
    console.log(
      `Verifica ${chat.agent}: ${index === 2 ? 'resume, globale abilitata per entrambi' : 'globale abilitata solo per Claude'}`,
    );
    try {
      await runAgent(
        config,
        chat,
        'Verifica tecnica: applica le skill repo-claude e repo-codex. Applica anche global-check SOLO se compare nel catalogo globale corrente. Leggi i rispettivi SKILL.md e riporta i loro codici esatti; non indovinarli. Se global-check non è disponibile scrivi GLOBAL_NON_DISPONIBILE. Non cercare skill fuori dal catalogo corrente, non usare MCP o Internet e non modificare file.',
        controller.signal,
        (e) => {
          if (e.type === 'session') chat.session_id = e.value;
          if (e.type === 'text') text = e.value;
          if (e.type === 'failure') failure = e.value;
        },
        undefined,
        access.instructions,
      );
      assert.equal(failure, '');
      assert.ok(text.includes(markers.claude), 'Skill progetto .claude non applicata');
      assert.ok(text.includes(markers.codex), 'Skill progetto .agents non applicata');
      assert.equal(
        text.includes(markers.global),
        index !== 1,
        'Assegnazione globale non rispettata',
      );
      if (index === 1) assert.ok(text.includes('GLOBAL_NON_DISPONIBILE'));
      console.log(`${chat.agent}: scope e lettura delle skill verificati`);
    } finally {
      clearTimeout(timer);
      await access.release();
    }
  }
  console.log('Prova completata. Fixture eliminate, repository utente invariate.');
} finally {
  store.close();
  await rm(dir, { recursive: true, force: true });
}
