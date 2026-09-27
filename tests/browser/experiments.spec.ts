import { test, expect } from '@playwright/test';

test('experimental settings are reachable from every tab and preserve global switches', async ({
  page,
  request,
}) => {
  await request.post('/api/settings/experiments', {
    data: { enabled: false, smartRouting: false },
  });
  await page.goto('/?settings=experiments');
  const dialog = page.getByRole('dialog', { name: 'Funzionalità sperimentali', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Routing intelligente' })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Abilita funzionalità sperimentali' }).check();
  await dialog.getByRole('checkbox', { name: 'Routing intelligente' }).check();
  await expect
    .poll(async () => (await (await request.get('/api/settings/experiments')).json()).smartRouting)
    .toBe(true);
  await page.reload();
  await expect(dialog.getByRole('checkbox', { name: 'Routing intelligente' })).toBeChecked();
  for (const name of ['MCP', 'Skill', 'Terminale', 'Voce']) {
    await dialog.getByRole('button', { name, exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Sperimentali', exact: true })
      .click();
    await expect(dialog).toBeVisible();
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(dialog.getByRole('button', { name: 'Sperimentali', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath('experimental-settings-mobile.png'),
    fullPage: true,
  });
  await dialog.getByRole('checkbox', { name: 'Abilita funzionalità sperimentali' }).uncheck();
  await expect(dialog.getByRole('checkbox', { name: 'Routing intelligente' })).toBeDisabled();
});

test('Codex chat creation, effort pool, persisted routing badge, manual override and Claude exclusion', async ({
  page,
  request,
}) => {
  await request.post('/api/settings/experiments', { data: { enabled: true, smartRouting: true } });
  let chatId = '';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Inizia una conversazione' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nuova chat', exact: true });
    await dialog.getByRole('button', { name: 'Codex', exact: true }).click();
    await dialog.locator('.chat-experiments-picker > summary').click();
    await dialog.getByRole('checkbox', { name: 'Routing intelligente' }).check();
    await expect(dialog.getByLabel('GPT-6-Sol high', { exact: true })).toBeChecked();
    await dialog.getByLabel('GPT-6-Sol low', { exact: true }).uncheck();
    await dialog.getByLabel('Preferenza routing').selectOption('quality');
    await dialog.getByLabel('Modello ed effort di riserva').selectOption('gpt-6-sol/high');
    const mcp = await dialog.locator('.chat-tools-picker').boundingBox();
    const experiments = await dialog.locator('.chat-experiments-picker').boundingBox();
    expect(experiments!.y).toBeGreaterThan(mcp!.y);
    // Switching providers discards an incompatible draft.
    await dialog.getByRole('button', { name: 'Claude Code', exact: true }).click();
    await expect(
      dialog.getByText('Routing JEV disponibile per Codex. Claude Code arriverà in seguito.'),
    ).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: 'Routing intelligente' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Codex', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: 'Routing intelligente' })).not.toBeChecked();
    await dialog.getByRole('checkbox', { name: 'Routing intelligente' }).check();
    await dialog.getByLabel('Modello ed effort di riserva').selectOption('gpt-6-sol/high');
    await dialog.getByLabel('GPT-6-Sol low', { exact: true }).uncheck();
    const created = page.waitForResponse(
      (res) => res.url().endsWith('/api/conversations') && res.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Crea chat', exact: true }).click();
    const chat = await (await created).json();
    chatId = chat.id;
    expect(chat.routing.enabled).toBe(true);
    expect(chat.routing.candidates).not.toContainEqual({ model: 'gpt-6-sol', effort: 'low' });
    await expect(page.locator('.model-picker-current')).toContainText('Automatico · JEV');
    await page
      .getByRole('textbox', { name: 'Messaggio', exact: true })
      .fill('Verifica routing di dimostrazione');
    await page.getByRole('button', { name: 'Invia messaggio' }).click();
    await expect(page.locator('.routing-badge')).toContainText('Demo → gpt-6-sol · high');
    await page.reload();
    await expect(page.locator('.routing-badge')).toContainText('Demo → gpt-6-sol · high');
    await page.locator('.model-picker > summary').click();
    await page.getByLabel('Modello della chat').selectOption('gpt-6-luna');
    await expect(page.locator('.model-picker-current')).not.toContainText('Automatico');
    const persisted = await (await request.get(`/api/conversations/${chatId}`)).json();
    expect(persisted.routing.enabled).toBe(false);
    expect(persisted.runs[0].routing.selected.model).toBe('gpt-6-sol');
    await page.locator('.model-picker > summary').click();
    await page.locator('.chat-experiments-picker > summary').click();
    await page.getByRole('checkbox', { name: 'Routing intelligente' }).check();
    await page.getByRole('button', { name: 'Salva esperimenti chat' }).click();
    await expect(page.locator('.model-picker-current')).toContainText('Automatico');
  } finally {
    if (chatId) await request.post(`/api/conversations/${chatId}/delete`);
    await request.post('/api/settings/experiments', {
      data: { enabled: false, smartRouting: false },
    });
  }
});

for (const scenario of ['Codex', 'Codex deselected', 'Claude Code']) {
  test(`chat experiments are hidden when created without active experiments: ${scenario}`, async ({
    page,
    request,
  }) => {
    await request.post('/api/settings/experiments', {
      data: { enabled: true, smartRouting: true },
    });
    let chatId = '';
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'Inizia una conversazione' }).click();
      const dialog = page.getByRole('dialog', { name: 'Nuova chat', exact: true });
      await dialog
        .getByRole('button', {
          name: scenario === 'Claude Code' ? 'Claude Code' : 'Codex',
          exact: true,
        })
        .click();
      if (scenario === 'Codex deselected') {
        await dialog.locator('.chat-experiments-picker > summary').click();
        const routing = dialog.getByRole('checkbox', { name: 'Routing intelligente' });
        await routing.check();
        await routing.uncheck();
      }
      const created = page.waitForResponse(
        (res) => res.url().endsWith('/api/conversations') && res.request().method() === 'POST',
      );
      await dialog.getByRole('button', { name: 'Crea chat', exact: true }).click();
      const chat = await (await created).json();
      chatId = chat.id;
      expect(chat.routing).toBeNull();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('textbox', { name: 'Messaggio', exact: true })).toBeVisible();
      await expect(page.locator('.chat-experiments-picker')).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole('textbox', { name: 'Messaggio', exact: true })).toBeVisible();
      await expect(page.locator('.chat-experiments-picker')).toHaveCount(0);
    } finally {
      if (chatId) await request.post(`/api/conversations/${chatId}/delete`);
      await request.post('/api/settings/experiments', {
        data: { enabled: false, smartRouting: false },
      });
    }
  });
}

test('missing credential and catalog cannot enable routing', async ({ page }) => {
  await page.route('**/api/settings/experiments', (route) =>
    route.fulfill({ json: { enabled: true, smartRouting: true, configured: false, demo: false } }),
  );
  await page.route('**/api/agents/codex/models', (route) =>
    route.fulfill({ json: { models: [], source: 'Unavailable', fetchedAt: null } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Inizia una conversazione' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nuova chat', exact: true });
  await dialog.getByRole('button', { name: 'Codex', exact: true }).click();
  await dialog.locator('.chat-experiments-picker > summary').click();
  await expect(dialog.getByRole('checkbox', { name: 'Routing intelligente' })).toBeDisabled();
  await expect(dialog.getByText('Chiave OpenRouter non configurata sul server.')).toBeVisible();
  await expect(dialog.getByText(/Catalogo Codex non disponibile/)).toBeVisible();
});

test('failed settings writes restore the toggle and show an error', async ({ page }) => {
  await page.route('**/api/settings/experiments', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 503, json: { error: 'Salvataggio non disponibile' } })
      : route.fulfill({
          json: { enabled: false, smartRouting: false, configured: true, demo: false },
        }),
  );
  await page.goto('/?settings=experiments');
  const dialog = page.getByRole('dialog', { name: 'Funzionalità sperimentali', exact: true });
  await dialog.getByRole('checkbox', { name: 'Abilita funzionalità sperimentali' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Salvataggio non disponibile');
  await expect(
    dialog.getByRole('checkbox', { name: 'Abilita funzionalità sperimentali' }),
  ).not.toBeChecked();
});
