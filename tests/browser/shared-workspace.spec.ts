import { test, expect } from '@playwright/test';

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
