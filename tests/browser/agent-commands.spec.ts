import { test, expect } from '@playwright/test';

for (const agent of ['claude', 'codex'] as const) {
  test(`${agent}: mobile command menu, execution, persistence and invalid command draft`, async ({
    page,
    request,
  }) => {
    const chat = await (
      await request.post('/api/conversations', { data: { agent, title: `Comandi ${agent}` } })
    ).json();
    const route = `/api/conversations/${chat.id}`;
    try {
      await page.setViewportSize({ width: 320, height: 780 });
      await page.goto(`/?chat=${chat.id}`);
      const input = page.getByRole('textbox', { name: 'Messaggio', exact: true });
      await expect(input).toBeEnabled();
      await input.fill('/');
      const menu = page.getByRole('region', { name: 'Comandi della chat' });
      await expect(menu.getByRole('button')).toHaveCount(3);
      await expect(menu.getByRole('button', { name: /\/context/ })).toHaveCount(
        agent === 'claude' ? 1 : 0,
      );
      await expect(menu.getByRole('button', { name: /\/status/ })).toHaveCount(
        agent === 'codex' ? 1 : 0,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `test-results/commands-${agent}-mobile.png`, fullPage: true });
      await menu.getByRole('button', { name: /\/usage/ }).click();
      await expect(input).toHaveValue('/usage');
      await expect(input).toBeFocused();
      await input.press('Enter');
      await expect(
        page.locator('.message.assistant').getByText('/usage · Dimostrazione', { exact: true }),
      ).toBeVisible();
      await expect(input).toHaveValue('');
      await page.reload();
      await expect(
        page.locator('.message.assistant').getByText('/usage · Dimostrazione', { exact: true }),
      ).toBeVisible();
      await input.fill('/unsupported');
      await input.press('Enter');
      await expect(page.getByText(/Comando non supportato\. Usa/)).toBeVisible();
      await expect(input).toHaveValue('/unsupported');
      const detail = await (await request.get(route)).json();
      expect(detail.runs).toHaveLength(1);
      expect(detail.runs[0].command).toBe('/usage');
      expect(detail.session_id).toBeNull();
    } finally {
      await request.post(route + '/delete', { data: {} });
    }
  });
}
