import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const exec = promisify(execFile);

for (const width of [320, 390]) {
  test(`review local and committed diffs on mobile ${width}px without changing files or sending messages`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const chat = await (
      await request.post('/api/conversations', {
        data: { agent: 'codex', repo: 'example/review-project', title: 'Controlla modifiche' },
      })
    ).json();
    const base = `/api/conversations/${chat.id}`;
    await request.post(base + '/git', { data: { action: 'prepare' } });
    const workspace = path.resolve('.data/e2e/workspaces', chat.id);
    const git = (...args: string[]) => exec('git', args, { cwd: workspace });
    await git('config', 'user.name', 'Demo');
    await git('config', 'user.email', 'demo@example.invalid');
    await writeFile(path.join(workspace, 'example.ts'), 'const message = "before";\n');
    await git('add', '.');
    await git('commit', '-m', 'Example');
    await writeFile(
      path.join(workspace, 'example.ts'),
      'const message = "after";\n' + '// a very long line '.repeat(40) + '\n',
    );
    await writeFile(path.join(workspace, 'new.txt'), 'new content\n');
    try {
      await page.goto(`/?chat=${chat.id}`);
      const trigger = page.getByRole('button', { name: 'Modifiche della chat', exact: true });
      await trigger.click();
      const sheet = page.getByRole('dialog', { name: 'Modifiche della chat' });
      await expect(sheet.getByText('2 file con differenze', { exact: true })).toBeVisible();
      await sheet.getByRole('button', { name: 'example.ts Modificato' }).click();
      await expect(sheet.locator('.diff-remove')).toContainText('before');
      await expect(sheet.locator('.diff-add').first()).toContainText('after');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect((await sheet.boundingBox())!.width).toBeLessThanOrEqual(width);
      for (const button of await sheet.locator('button:visible').all())
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `test-results/diff-${width}.png` });
      await sheet.getByRole('button', { name: 'Tutti i file modificati' }).click();
      await sheet.getByRole('button', { name: 'new.txt Aggiunto · nuovo file' }).click();
      await expect(sheet.locator('.diff-add')).toContainText('new content');
      await sheet.getByRole('button', { name: 'Chiudi modifiche' }).click();
      await expect(trigger).toBeFocused();
      await git('add', '.');
      await git('commit', '-m', 'Agent changes');
      await trigger.click();
      await sheet.getByRole('button', { name: 'Tutti i file modificati' }).click();
      await expect(sheet.getByText('Nessuna differenza nel confronto selezionato.')).toBeVisible();
      await sheet.getByRole('button', { name: 'Confronto branch', exact: true }).click();
      await expect(sheet.getByRole('combobox', { name: 'Branch di confronto' })).toHaveValue(
        'refs/heads/main',
      );
      await expect(sheet.getByText('2 file con differenze', { exact: true })).toBeVisible();
      await sheet.getByRole('button', { name: 'example.ts Aggiunto' }).click();
      await expect(sheet.locator('.diff-add').first()).toContainText('after');
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      expect((await (await request.get(base)).json()).runs).toHaveLength(0);
      expect((await git('status', '--porcelain')).stdout).toBe('');
    } finally {
      await request.post(base + '/delete', { data: {} });
    }
  });
}

test('work states survive reload, distinguish failures and expose an overview of chats needing attention', async ({
  page,
  request,
}) => {
  const chat = await (
    await request.post('/api/conversations', {
      data: { agent: 'codex', title: 'Stati verificabili' },
    })
  ).json();
  const base = `/api/conversations/${chat.id}`;
  try {
    await request.post(base + '/queue/pause', { data: { paused: true } });
    await request.post(base + '/turns', { data: { text: 'Esegui il lavoro demo' } });
    await page.goto(`/?chat=${chat.id}`);
    const status = page.getByRole('region', { name: 'Stato del lavoro' });
    await expect(status.getByText('Coda in pausa', { exact: true })).toBeVisible();
    await page.reload();
    await expect(status.getByText('Coda in pausa', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Riprendi coda', exact: true }).click();
    await expect(status.getByText('In corso', { exact: true })).toBeVisible();
    await expect(status.getByText('Completato', { exact: true })).toBeVisible();
    await expect(status).toContainText('Le verifiche effettuate sono descritte nella risposta.');
    await page.reload();
    await expect(status.getByText('Completato', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Attività del lavoro', exact: true }).click();
    await expect(page.locator('.activity-list .lucide-check')).toHaveCount(0);
    await page.getByRole('button', { name: 'Chiudi attività', exact: true }).click();
    // Replay the API states that otherwise require a real CLI failure/clarification.
    for (const [value, label] of [
      ['error', 'Errore'],
      ['cancelled', 'Fermato'],
      ['interrupted', 'Interrotto'],
      ['awaiting_input', 'Serve una risposta'],
    ] as const) {
      await page.route(`**${base}`, async (route) => {
        const data = await (await route.fetch()).json();
        data.runs.at(-1).status = value;
        data.runs.at(-1).error =
          value === 'awaiting_input' ? null : 'Motivo del cambiamento di stato';
        await route.fulfill({ json: data });
      });
      await page.route('**/api/conversations', async (route) => {
        const data = await (await route.fetch()).json();
        data.find((c: any) => c.id === chat.id).status = value;
        await route.fulfill({ json: data });
      });
      await page.reload();
      await expect(status.getByText(label, { exact: true })).toBeVisible();
      if (value === 'awaiting_input')
        await expect(
          page.getByRole('button', { name: 'Invia risposta', exact: true }),
        ).toBeVisible();
      else await expect(status).toContainText('Motivo del cambiamento di stato');
      await page.unroute(`**${base}`);
      await page.unroute('**/api/conversations');
    }
    await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
    await page.getByRole('button', { name: 'Lavori in corso e da seguire', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Stati verificabili Codex', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Stati verificabili Codex', exact: true }).click();
    await expect(page.locator('.chat-title')).toHaveText('Stati verificabili');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await request.post(base + '/delete', { data: {} });
  }
});

test('changing chat discards an outstanding diff response', async ({ page, request }) => {
  const chats = [];
  for (const title of ['Diff prima chat', 'Diff seconda chat']) {
    const chat = await (
      await request.post('/api/conversations', { data: { agent: 'codex', title } })
    ).json();
    chats.push(chat);
  }
  try {
    await page.goto(`/?chat=${chats[0].id}`);
    await page.route(`**/api/conversations/${chats[0].id}/diff?**`, async (route) => {
      await new Promise((r) => setTimeout(r, 400));
      await route.fulfill({
        json: {
          git: { ready: true, branch: 'old-branch' },
          files: [{ path: 'old-secret.txt', status: 'A' }],
          total: 1,
        },
      });
    });
    await page.getByRole('button', { name: 'Modifiche della chat', exact: true }).click();
    await page.getByRole('button', { name: 'Chiudi modifiche' }).click();
    await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
    await page.getByRole('button', { name: 'Diff seconda chat Codex', exact: true }).click();
    await page.getByRole('button', { name: 'Modifiche della chat', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Modifiche della chat' })).toContainText(
      'Il repository non è ancora disponibile.',
    );
    await expect(page.getByText('old-secret.txt')).toHaveCount(0);
  } finally {
    for (const chat of chats)
      await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
  }
});
