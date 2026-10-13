import { test, expect } from '@playwright/test';

for (const width of [320, 390, 1280]) {
  test(`profile accounts at ${width}px: loads on demand, refreshes and restores focus`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    let calls = 0;
    await page.route('**/api/agent-accounts', async (route) => {
      calls++;
      await route.fulfill({
        json: {
          checkedAt: new Date().toISOString(),
          accounts: [
            {
              agent: 'claude',
              status: 'connected',
              email: 'claude-with-a-long-account-name@example.test',
              plan: 'max',
              method: 'Claude.ai',
              organization: 'Example organization',
            },
            {
              agent: 'codex',
              status: calls === 1 ? 'connected' : 'signed_out',
              email: calls === 1 ? 'codex@example.test' : null,
              plan: 'plus',
              method: 'ChatGPT',
              organization: null,
            },
          ],
        },
      });
    });
    await page.goto('/');
    if (width < 768) await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
    const trigger = page.getByRole('button', { name: 'Account e abbonamenti', exact: true });
    await expect(trigger).toBeVisible();
    expect(calls).toBe(0);
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Account e abbonamenti' });
    await expect(dialog.getByText('claude-with-a-long-account-name@example.test')).toBeVisible();
    await expect(dialog.getByText('codex@example.test')).toBeVisible();
    await expect(dialog.getByText('max', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/accounts-${width}.png`, fullPage: true });
    await dialog.getByRole('button', { name: 'Aggiorna account' }).click();
    await expect(dialog.getByText('Non connesso', { exact: true })).toBeVisible();
    await expect(dialog.getByText('codex@example.test')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(dialog.getByText('Non connesso', { exact: true })).toBeVisible();
    expect(calls).toBe(3);
    await dialog.getByRole('button', { name: 'Chiudi account' }).click();
    await expect(trigger).toBeFocused();
  });
}

test('profile remains available in landscape and reports demo, missing data, partial and request failures', async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Apri menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  const trigger = page.getByRole('button', { name: 'Account e abbonamenti', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Account e abbonamenti' });
  await expect(dialog.getByText('Dimostrazione', { exact: true })).toHaveCount(2);
  await page.route('**/api/agent-accounts', (route) =>
    route.fulfill({
      json: {
        checkedAt: new Date().toISOString(),
        accounts: [
          {
            agent: 'claude',
            status: 'connected',
            email: null,
            plan: null,
            method: 'Token OAuth',
            organization: null,
          },
          {
            agent: 'codex',
            status: 'unavailable',
            email: null,
            plan: null,
            method: null,
            organization: null,
          },
        ],
      },
    }),
  );
  await dialog.getByRole('button', { name: 'Aggiorna account' }).click();
  await expect(dialog.getByText('Identità non comunicata dalla CLI')).toBeVisible();
  await expect(dialog.getByText('Stato non disponibile', { exact: true })).toBeAttached();
  await page.route('**/api/agent-accounts', (route) =>
    route.fulfill({ status: 503, json: { error: 'Unavailable' } }),
  );
  await dialog.getByRole('button', { name: 'Aggiorna account' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Impossibile leggere gli account. Riprova.');
  await expect(dialog.getByRole('button', { name: 'Aggiorna account' })).toBeEnabled();
});
