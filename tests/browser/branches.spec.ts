import { test, expect } from '@playwright/test';
import { writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const exec = promisify(execFile);

for (const width of [320, 390])
  test(`mobile ${width}px: real branch switch/create, long names and no accidental message submission`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const chat = await (
      await request.post('/api/conversations', {
        data: {
          agent: 'codex',
          repo: 'example/repository-con-un-nome-molto-lungo',
          title: 'Branch mobile',
        },
      })
    ).json();
    const base = `/api/conversations/${chat.id}`;
    await page.goto(`/?chat=${chat.id}`);
    const trigger = page.getByRole('button', { name: 'Repository e branch', exact: true });
    await trigger.click();
    const sheet = page.getByRole('dialog', { name: 'Repository e branch', exact: true });
    await sheet.getByRole('button', { name: 'Prepara repository', exact: true }).click();
    await expect(sheet.locator('.branch-current')).toContainText(`agent/${chat.id.slice(0, 8)}`);
    await sheet.getByRole('button', { name: 'main', exact: true }).click();
    await expect(sheet.locator('.branch-current')).toHaveText('main');
    await sheet.getByRole('button', { name: 'Nuovo branch', exact: true }).click();
    const name = 'feature/questa-e-una-funzionalita-con-un-nome-molto-lungo-per-il-mobile';
    await sheet.getByRole('textbox', { name: 'Nome del nuovo branch', exact: true }).fill(name);
    await sheet
      .getByRole('combobox', { name: 'Branch di partenza' })
      .selectOption('refs/heads/main');
    await sheet.getByRole('button', { name: 'Crea e passa al branch', exact: true }).click();
    await expect(sheet.locator('.branch-current')).toHaveText(name);
    await sheet.getByRole('searchbox', { name: 'Cerca un branch' }).fill('feature/');
    await expect(sheet.locator('.branch-option')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const box = await sheet.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(width);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    for (const button of await sheet.locator('button:visible').all())
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(
      await sheet
        .locator('input')
        .last()
        .evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe('16px');
    await page.screenshot({ path: `test-results/branches-${width}.png`, fullPage: true });
    await sheet.getByRole('button', { name: 'Chiudi branch' }).click();
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText(name);
    await page.reload();
    await expect(trigger).toContainText(name);
    expect((await (await request.get(base)).json()).runs).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/branch-composer-${width}.png`, fullPage: true });
    await request.post(base + '/delete', { data: {} });
  });

test('branch panel explains dirty files and queued work, and refreshes external Git changes', async ({
  page,
  request,
}) => {
  const chat = await (
    await request.post('/api/conversations', {
      data: { agent: 'codex', repo: 'example/project', title: 'Branch protection' },
    })
  ).json();
  const base = `/api/conversations/${chat.id}`;
  await request.post(base + '/git', { data: { action: 'prepare' } });
  const workspace = path.resolve('.data/e2e/workspaces', chat.id);
  await writeFile(path.join(workspace, 'unfinished.txt'), 'keep these edits');
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: 'Repository e branch', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Repository e branch', exact: true });
  await expect(sheet.getByText(/file con modifiche locali/)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Nuovo branch', exact: true })).toBeDisabled();
  await expect(sheet.getByRole('button', { name: 'main', exact: true })).toBeDisabled();
  await rm(path.join(workspace, 'unfinished.txt'));
  await exec('git', ['switch', 'main'], { cwd: workspace });
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Repository e branch', exact: true }),
  ).toContainText('main');
  await request.post(base + '/queue/pause', { data: { paused: true } });
  const queued = await (
    await request.post(base + '/turns', { data: { text: 'Da eseguire' } })
  ).json();
  await page.getByRole('button', { name: 'Repository e branch', exact: true }).click();
  await expect(sheet.getByText(/Ci sono messaggi in coda/)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Nuovo branch', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await request.post(base + `/queue/${queued.runId}/delete`, { data: {} });
  await request.post(base + '/delete', { data: {} });
});
