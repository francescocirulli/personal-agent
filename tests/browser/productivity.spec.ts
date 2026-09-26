import { test, expect } from '@playwright/test';

test('mobile drafts preserve text and documents across chat switches and reload, upload/download clears the draft', async ({
  page,
  request,
}) => {
  const a = await (
    await request.post('/api/conversations', { data: { agent: 'codex', title: 'Bozza documenti' } })
  ).json();
  const b = await (
    await request.post('/api/conversations', { data: { agent: 'codex', title: 'Altra bozza' } })
  ).json();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: ShareData) => {
        (window as any).sharedNames = data.files?.map((file) => file.name);
      },
    });
  });
  await page.goto(`/?chat=${a.id}`);
  const composer = page.getByRole('textbox', { name: 'Messaggio', exact: true });
  await composer.fill('Analizza le spese');
  await page.getByLabel('Seleziona allegati').setInputFiles({
    name: 'spese.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('voce,spesa\ncena,42'),
  });
  await expect(page.getByLabel('Allegati da inviare')).toContainText('spese.csv');
  await page.getByRole('button', { name: 'Apri menu' }).click();
  await page.locator('.chat-link').filter({ hasText: 'Altra bozza' }).click();
  await expect(composer).toHaveValue('');
  await composer.fill('Seconda bozza');
  await page.getByRole('button', { name: 'Apri menu' }).click();
  await page.locator('.chat-link').filter({ hasText: 'Bozza documenti' }).click();
  await expect(composer).toHaveValue('Analizza le spese');
  await expect(page.getByLabel('Allegati da inviare')).toContainText('spese.csv');
  await page.reload();
  await expect(composer).toHaveValue('Analizza le spese');
  await expect(page.getByLabel('Allegati da inviare')).toContainText('spese.csv');
  await page.getByRole('button', { name: 'Invia messaggio', exact: true }).click();
  await expect(page.locator('.file-card')).toContainText('spese.csv');
  await expect(composer).toHaveValue('');
  await page.getByRole('button', { name: 'Condividi', exact: true }).click();
  await page.getByRole('button', { name: 'Condividi file', exact: true }).click();
  expect(await page.evaluate(() => (window as any).sharedNames)).toEqual(['spese.csv']);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Scarica', exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('spese.csv');
  await page.reload();
  await expect(composer).toHaveValue('');
  await expect(page.getByLabel('Allegati da inviare')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/documents-mobile.png', fullPage: true });
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/conversations/${a.id}`)).json()).runs.at(-1)?.status,
    )
    .toBe('complete');
  await request.post(`/api/conversations/${a.id}/delete`, { data: {} });
  await request.post(`/api/conversations/${b.id}/delete`, { data: {} });
});

test('mobile queue allows edit, reorder, delete and pause without losing requests', async ({
  page,
  request,
}) => {
  const chat = await (
    await request.post('/api/conversations', { data: { agent: 'codex', title: 'Gestione coda' } })
  ).json();
  const base = `/api/conversations/${chat.id}`;
  await request.post(base + '/queue/pause', { data: { paused: true } });
  for (const text of ['Primo', 'Secondo', 'Terzo'])
    await request.post(base + '/turns', { data: { text } });
  await page.goto(`/?chat=${chat.id}`);
  const queue = page.getByRole('region', { name: 'Messaggi in coda' });
  await expect(queue).toContainText('In pausa');
  const second = queue.getByRole('listitem').filter({ hasText: 'Secondo' });
  await second.getByRole('button', { name: 'Modifica', exact: true }).click();
  await page.getByRole('textbox', { name: 'Modifica messaggio in coda' }).fill('Secondo corretto');
  await queue.getByRole('button', { name: 'Salva', exact: true }).click();
  await expect(second).toContainText('Secondo corretto');
  await second.getByRole('button', { name: 'Sposta prima' }).click();
  await expect(queue.getByRole('listitem').first()).toContainText('Secondo corretto');
  await queue
    .getByRole('listitem')
    .filter({ hasText: 'Terzo' })
    .getByRole('button', { name: 'Elimina', exact: true })
    .click();
  await expect(queue.getByRole('listitem')).toHaveCount(2);
  await page.reload();
  await expect(queue.getByRole('listitem').first()).toContainText('Secondo corretto');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/queue-controls-mobile.png', fullPage: true });
  await queue.getByRole('button', { name: 'Riprendi coda' }).click();
  await expect(queue).toHaveCount(0, { timeout: 10000 });
  await expect
    .poll(async () =>
      (await (await request.get(base)).json()).runs.every((r: any) => r.status === 'complete'),
    )
    .toBe(true);
  await request.post(base + '/delete', { data: {} });
});

test('search finds content outside titles and jumps to the selected message, including reload', async ({
  page,
  request,
}) => {
  const chat = await (
    await request.post('/api/conversations', {
      data: { agent: 'codex', title: 'Progetto ricerca' },
    })
  ).json();
  const base = `/api/conversations/${chat.id}`;
  await request.post(base + '/turns', { data: { text: 'La parola da trovare è CaffèUnico' } });
  await expect.poll(async () => (await (await request.get(base)).json()).messages.length).toBe(2);
  await page.goto('/');
  await page.getByRole('button', { name: 'Apri menu' }).click();
  await page.getByRole('textbox', { name: 'Cerca nelle chat' }).fill('CAFFEUNICO');
  const results = page.getByRole('region', { name: 'Risultati nei messaggi' });
  await expect(results.locator('.search-result')).toHaveCount(2);
  await results
    .locator('.search-result')
    .filter({ has: page.getByText('Tu', { exact: true }) })
    .click();
  await expect(page.locator('.message.user.search-highlight')).toContainText('CaffèUnico');
  await expect(page).toHaveURL(/message=/);
  await page.reload();
  await expect(page.locator('.message.user.search-highlight')).toBeInViewport();
  await page.screenshot({ path: 'test-results/search-message-mobile.png', fullPage: true });
  await request.post(base + '/delete', { data: {} });
});
