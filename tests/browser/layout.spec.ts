import { test, expect } from '@playwright/test';

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 640, height: 400 },
  { width: 1440, height: 900 },
]) {
  test(`layout ${viewport.width}×${viewport.height}: reachable navigation, composer and settings`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    const chat = await (
      await request.post('/api/conversations', {
        data: {
          agent: 'codex',
          title: 'Una conversazione con un titolo lungo da leggere sul telefono',
          repo: 'example/repository-con-un-nome-molto-lungo',
        },
      })
    ).json();
    const noOverflow = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    };
    try {
      await page.goto(`/?chat=${chat.id}`);
      await expect(page.getByLabel('Messaggio', { exact: true })).toBeEnabled();
      await noOverflow();
      for (const label of [
        'Allega immagini e documenti',
        'Apri modalità voce',
        'Invia messaggio',
      ]) {
        const control = page.getByRole('button', { name: label, exact: true });
        const box = (await control.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      }
      await page.screenshot({
        path: `test-results/layout-chat-${viewport.width}-${test.info().project.name}.png`,
      });
      if (viewport.width <= 640) {
        await expect(page.getByLabel('Cerca nelle chat')).toBeHidden();
        await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
        await expect(page.getByLabel('Cerca nelle chat')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Apri menu', exact: true })).toHaveAttribute(
          'aria-expanded',
          'true',
        );
        await page.getByRole('button', { name: 'Chiudi storico', exact: true }).click();
        await expect(page.getByLabel('Cerca nelle chat')).toBeHidden();
      }
      if (viewport.width <= 640)
        await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
      await page.getByRole('button', { name: 'Impostazioni', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Impostazioni voce', exact: true });
      await expect(dialog).toBeVisible();
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
      for (const tab of await dialog.locator('.settings-tabs button').all()) {
        const box = (await tab.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await dialog.getByRole('button', { name: 'MCP', exact: true }).click();
      await expect(
        page.getByRole('dialog', { name: 'Collegamenti MCP', exact: true }),
      ).toBeVisible();
      await noOverflow();
      await page.screenshot({
        path: `test-results/layout-settings-${viewport.width}-${test.info().project.name}.png`,
      });
    } finally {
      await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
    }
  });
}
