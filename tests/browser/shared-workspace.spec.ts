import { test, expect } from '@playwright/test';

for (const width of [320, 390, 1440])
  test(`project shortcut creates shared and isolated chats at ${width}px`, async ({
    page,
    request,
  }) => {
    const ids: string[] = [];
    const project = `Example/Progetto-con-un-nome-molto-lungo-${width}`;
    try {
      const seed = await (
        await request.post('/api/conversations', {
          data: { agent: 'codex', repo: project, title: 'Progetto rapido' },
        })
      ).json();
      ids.push(seed.id);
      const other = await (
        await request.post('/api/conversations', {
          data: { agent: 'claude', repo: 'example/altro-progetto' },
        })
      ).json();
      ids.push(other.id);
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/?chat=${other.id}`);
      await expect(page.getByLabel('Messaggio', { exact: true })).toBeEnabled();
      const sidebar = page.getByRole('complementary', {
        name: 'Conversazioni',
        includeHidden: true,
      });
      const shortcut = sidebar.getByRole('button', {
        name: `Nuova chat in ${project.toLowerCase()}`,
        exact: true,
      });
      const group = sidebar.locator('.chat-group-container').filter({
        has: page.getByRole('button', {
          name: `Nuova chat in ${project.toLowerCase()}`,
          exact: true,
          includeHidden: true,
        }),
      });
      const dialog = page.getByRole('dialog', { name: 'Nuova chat', exact: true });
      for (const mode of ['shared', 'isolated'] as const) {
        if (width <= 640)
          await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
        await expect(shortcut).toBeVisible();
        if (mode === 'shared') await group.locator('summary').click();
        await expect(group.locator('details')).not.toHaveAttribute('open');
        await shortcut.click({ trial: true });
        const bounds = (await shortcut.boundingBox())!;
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: `test-results/project-shortcut-${width}-${mode}-${test.info().project.name}.png`,
        });
        await shortcut.focus();
        await shortcut.press('Enter');
        await expect(dialog).toBeVisible();
        await expect(group.locator('details')).not.toHaveAttribute('open');
        await expect(dialog.getByLabel('Progetto selezionato')).toContainText(
          project.split('/')[1],
        );
        await expect(dialog.getByRole('button', { name: 'Codex', exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        const picker = dialog.getByRole('group', { name: 'Cartella di lavoro', exact: true });
        await picker
          .getByRole('button', { name: mode === 'shared' ? 'Condivisa' : 'Isolata', exact: true })
          .click();
        if (mode === 'isolated')
          await dialog.getByRole('button', { name: 'Claude Code', exact: true }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: `test-results/project-dialog-${width}-${mode}-${test.info().project.name}.png`,
        });
        const response = page.waitForResponse(
          (r) => r.url().endsWith('/api/conversations') && r.request().method() === 'POST',
        );
        await dialog.getByRole('button', { name: 'Crea chat', exact: true }).click();
        const created = await (await response).json();
        ids.push(created.id);
        expect(created.repo).toBe(project);
        expect(created.workspace_mode).toBe(mode);
        expect(created.agent).toBe(mode === 'shared' ? 'codex' : 'claude');
        await expect(dialog).toBeHidden();
        await expect(page).toHaveURL(new RegExp(`chat=${created.id}`));
      }
      // Cancelling a project shortcut must not leak its repository or mode into generic creation.
      if (width <= 640) await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
      await shortcut.click();
      await dialog.getByRole('button', { name: 'Condivisa', exact: true }).click();
      await dialog.getByRole('button', { name: 'Chiudi', exact: true }).click();
      await page.getByRole('button', { name: 'Nuova chat', exact: true }).last().click();
      await expect(
        dialog.getByRole('button', { name: 'Chat libera', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await dialog.getByRole('button', { name: 'Repository GitHub', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Isolata', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    } finally {
      for (const id of ids) await request.post(`/api/conversations/${id}/delete`, { data: {} });
    }
  });

for (const width of [320, 390])
  test(`workspace choice at ${width}px defaults to isolated and persists shared mode`, async ({
    page,
    request,
  }) => {
    let chatId: string | undefined;
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      await page.getByRole('button', { name: 'Nuova chat', exact: true }).first().click();
      const picker = page.getByRole('group', { name: 'Cartella di lavoro', exact: true });
      await expect(picker).toHaveCount(0);
      await page.getByRole('button', { name: 'Repository GitHub', exact: true }).click();
      await page
        .getByRole('button', { name: 'Inserisci un repository manualmente', exact: true })
        .click();
      await page.getByLabel('Percorso repository').fill('example/project');
      await expect(picker.getByRole('button', { name: 'Isolata', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await picker.getByRole('button', { name: 'Condivisa', exact: true }).click();
      await expect(picker.getByRole('button', { name: 'Condivisa', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const created = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/conversations') && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Crea chat', exact: true }).click();
      const chat = await (await created).json();
      chatId = chat.id;
      expect(chat.workspace_mode).toBe('shared');
      await page.reload();
      expect(
        (await (await request.get(`/api/conversations/${chatId}`)).json()).workspace_mode,
      ).toBe('shared');
      await page.getByRole('button', { name: 'Nuova chat', exact: true }).first().click();
      await page.getByRole('button', { name: 'Repository GitHub', exact: true }).click();
      await expect(picker.getByRole('button', { name: 'Isolata', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    } finally {
      if (chatId) await request.post(`/api/conversations/${chatId}/delete`, { data: {} });
    }
  });
