import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/app';
import { readConfig } from '../../server/config';

// Exercise the real runner and cancellation route with disposable CLI doubles.
// No provider login, subscription request, or external repository is involved.
for (const agent of ['codex', 'claude'] as const) {
  test(`stop and resume ${agent} from the chat preserves context and terminates child processes`, async ({
    page,
  }) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pa-stop-ui-'));
    const previousCodexHome = process.env.AGENT_CODEX_HOME;
    process.env.AGENT_CODEX_HOME = dir;
    const bin = path.join(dir, 'agent.cjs');
    await writeFile(
      path.join(dir, 'child.cjs'),
      `const { writeFileSync } = require('node:fs');
const path = require('node:path');
process.on('SIGTERM', () => {
  writeFileSync(path.join(__dirname, 'child-stopped'), 'stopped');
  process.exit(0);
});
process.send('ready');
setInterval(() => {}, 1000);
`,
    );
    await writeFile(
      bin,
      `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync, readFileSync } = require('node:fs');
const path = require('node:path');
const claude = process.argv.includes('-p');
const { DatabaseSync } = require('node:sqlite');
const db = claude ? null : new DatabaseSync(path.join(process.env.CODEX_HOME, 'state_5.sqlite'));
db?.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, model TEXT, updated_at INTEGER)');
const reportModel = () => {
  let model = 'fixture-model-one';
  try { model = readFileSync(path.join(__dirname, 'model-choice'), 'utf8'); } catch {}
  if (claude) console.log(JSON.stringify({ type: 'assistant', message: { model, content: [] } }));
  else db.prepare('INSERT INTO threads VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model,updated_at=excluded.updated_at')
    .run('stop-resume-session', model, Math.floor(Date.now() / 1000));
};
console.log(JSON.stringify(claude
  ? { type: 'system', subtype: 'init', session_id: 'stop-resume-session' }
  : { type: 'thread.started', thread_id: 'stop-resume-session' }));
reportModel();
setInterval(reportModel, 300);
let input = '';
process.stdin.on('data', data => input += data);
process.stdin.on('end', () => writeFileSync(path.join(__dirname, 'input.json'), JSON.stringify({ input, args: process.argv.slice(2) })));
const child = spawn(process.execPath, [path.join(__dirname, 'child.cjs')], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
  writeFileSync(path.join(__dirname, 'parent-stopped'), 'stopped');
});
child.on('exit', () => { if (stopping) process.exit(0); });
child.on('message', () => {
  writeFileSync(path.join(__dirname, 'ready.json'), JSON.stringify({ parent: process.pid, child: child.pid }));
  const event = process.argv.includes('exec')
    ? { type: 'item.started', item: { type: 'command_execution', command: 'Test controllato in corso' } }
    : { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'Test controllato in corso' } }] } };
  console.log(JSON.stringify(event));
});
process.stdin.resume();
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    const config = {
      ...readConfig(),
      dataDir: dir,
      demo: false,
      unrestricted: false,
      password: '',
      audioKey: '',
      vapidPublic: '',
      vapidPrivate: '',
      claudeBin: bin,
      codexBin: bin,
    };
    const runtime = createApp(config);
    const server = runtime.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    config.port = (server.address() as { port: number }).port;
    config.origin = `http://127.0.0.1:${config.port}`;
    const exists = async (name: string) => readFile(path.join(dir, name), 'utf8').catch(() => '');
    try {
      const response = await page.request.post(`${config.origin}/api/conversations`, {
        data: { agent, title: `Interrompi ${agent}` },
      });
      expect(response.ok()).toBe(true);
      const chat = await response.json();
      await page.setViewportSize({ width: agent === 'codex' ? 320 : 390, height: 844 });
      await page.goto(`${config.origin}/?chat=${chat.id}`);
      await page
        .getByRole('textbox', { name: 'Messaggio', exact: true })
        .fill('Avvia il lavoro di prova');
      await page.getByRole('button', { name: 'Invia messaggio', exact: true }).click();
      await expect.poll(() => exists('ready.json')).not.toBe('');
      const pids = JSON.parse(await exists('ready.json')) as { parent: number; child: number };
      const card = page.getByRole('region', { name: 'Stato del lavoro' });
      await expect(card.getByText('In corso', { exact: true })).toBeVisible();
      const modelPicker = page.locator('.model-picker');
      await expect(modelPicker.locator('summary')).toContainText('fixture-model-one');
      await writeFile(path.join(dir, 'model-choice'), 'fixture-model-two');
      await expect(modelPicker.locator('summary')).toContainText('fixture-model-two');
      await page.request.post(`${config.origin}/api/conversations/${chat.id}/model`, {
        data: { model: 'fixture-next-choice' },
      });
      await modelPicker.locator('summary').click();
      await expect(modelPicker.getByRole('status')).toHaveText('In uso: fixture-model-two');
      await expect(modelPicker.getByLabel('Modello della chat')).toHaveValue('fixture-next-choice');
      await expect(modelPicker.locator('summary')).toContainText('fixture-model-two');
      await modelPicker.getByLabel('Modello della chat').selectOption('');
      await modelPicker.locator('summary').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const stop = card.getByRole('button', { name: 'Ferma task' });
      await expect(stop).toBeEnabled();
      expect((await stop.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `test-results/agent-running-${agent}.png` });

      // Delay only the HTTP response to verify pending feedback and double-click protection.
      await page.route(`**/api/conversations/${chat.id}/cancel`, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await route.continue();
      });
      await stop.click();
      await expect(stop).toBeDisabled();
      await expect(stop).toHaveText('Arresto…');
      await expect(card.getByText('Fermato', { exact: true })).toBeVisible();
      await expect(stop).toHaveCount(0);
      await expect.poll(() => exists('parent-stopped')).toBe('stopped');
      await expect.poll(() => exists('child-stopped')).toBe('stopped');
      for (const pid of Object.values(pids)) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      expect(runtime.store.runs(chat.id)[0].status).toBe('cancelled');
      await page.reload();
      await expect(modelPicker.locator('summary')).toContainText('fixture-model-two');
      await modelPicker.locator('summary').click();
      await expect(modelPicker.getByRole('status')).toHaveText(
        'Ultimo modello usato: fixture-model-two',
      );
      await modelPicker.locator('summary').click();
      await expect(card.getByText('Fermato', { exact: true })).toBeVisible();
      await expect(stop).toHaveCount(0);
      const resume = card.getByRole('button', { name: 'Riprendi task' });
      await expect(resume).toBeEnabled();
      await expect(card).not.toContainText('Task fermato su richiesta.');
      await page
        .getByRole('textbox', { name: 'Messaggio', exact: true })
        .fill('Bozza da conservare');
      await page.screenshot({ path: `test-results/agent-stopped-${agent}.png` });
      await page.route(`**/api/conversations/${chat.id}/runs/*/resume`, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await route.continue();
      });
      await resume.click();
      await expect(resume).toBeDisabled();
      await expect(resume).toHaveText('Riprendo…');
      await expect(card.getByText('In corso', { exact: true })).toBeVisible();
      await expect
        .poll(async () => JSON.parse(await exists('ready.json')).parent)
        .not.toBe(pids.parent);
      await expect
        .poll(async () => JSON.parse(await exists('input.json')).args)
        .toContain('stop-resume-session');
      const resumedInput = JSON.parse(await exists('input.json'));
      expect(resumedInput.input).toContain('Richiesta originale:\nAvvia il lavoro di prova');
      expect(runtime.store.runs(chat.id)).toHaveLength(2);
      expect(runtime.store.runs(chat.id)[0].status).toBe('cancelled');
      await expect(page.getByRole('textbox', { name: 'Messaggio', exact: true })).toHaveValue(
        'Bozza da conservare',
      );
      await stop.click();
      await expect(card.getByText('Fermato', { exact: true })).toBeVisible();
      await expect(resume).toBeEnabled();
    } finally {
      await page.goto('about:blank');
      await runtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
      if (previousCodexHome === undefined) delete process.env.AGENT_CODEX_HOME;
      else process.env.AGENT_CODEX_HOME = previousCodexHome;
    }
  });
}
