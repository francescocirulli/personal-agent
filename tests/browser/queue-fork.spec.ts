import { test, expect } from '@playwright/test';

test('mobile queue: compose while working, reload, send now and automatic drain', async ({
  page,
  request,
}) => {
  const chat = await (
    await request.post('/api/conversations', { data: { agent: 'codex', title: 'Coda mobile' } })
  ).json();
  const base = `/api/conversations/${chat.id}`;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('textbox', { name: 'Messaggio' }).fill('Primo task');
  await page.getByRole('button', { name: 'Invia messaggio', exact: true }).click();
  // Keep a backlog long enough to interact and reload without timing the demo reply.
  for (let i = 0; i < 4; i++)
    await request.post(`${base}/turns`, { data: { text: `Messaggio precedente ${i}` } });
  const composer = page.getByRole('textbox', { name: 'Messaggio' });
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Allega immagini e documenti' })).toBeEnabled();
  await composer.fill('Messaggio urgente');
  await page.getByRole('button', { name: 'Aggiungi alla coda' }).click();
  const queue = page.getByRole('region', { name: 'Messaggi in coda' });
  await expect(queue.getByText('Messaggio urgente', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('');
  await page.reload();
  await expect(queue.getByText('Messaggio urgente', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/queue-mobile.png', fullPage: true });
  const before = await (await request.get(base)).json();
  const urgent = before.queue.find((m: any) => m.text === 'Messaggio urgente');
  await queue
    .getByRole('listitem')
    .filter({ hasText: 'Messaggio urgente' })
    .getByRole('button', { name: 'Invia subito' })
    .click();
  await expect
    .poll(async () => {
      const detail = await (await request.get(base)).json();
      return detail.runs.find((r: any) => r.id === urgent.run_id).status;
    })
    .not.toBe('queued');
  await expect(
    page.locator('.message.user').filter({ hasText: 'Messaggio urgente' }),
  ).toBeVisible();
  await expect(queue).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Ferma task' })).toHaveCount(0, { timeout: 5000 });
  const done = await (await request.get(base)).json();
  expect(done.runs.some((r: any) => r.status === 'cancelled')).toBe(true);
  expect(
    done.messages.filter((m: any) => m.role === 'user' && m.text === 'Messaggio urgente'),
  ).toHaveLength(1);
  expect(errors).toEqual([]);
  await request.post(`${base}/delete`, { data: {} });
});

test('fork only on assistant replies opens an independent chat listed in the sidebar', async ({
  page,
  request,
}) => {
  const chat = await (
    await request.post('/api/conversations', { data: { agent: 'claude', title: 'Origine fork' } })
  ).json();
  const base = `/api/conversations/${chat.id}`;
  await request.post(`${base}/turns`, { data: { text: 'Contesto iniziale' } });
  await expect.poll(async () => (await (await request.get(base)).json()).messages.length).toBe(2);
  await request.post(`${base}/turns`, { data: { text: 'Messaggio successivo escluso' } });
  await expect.poll(async () => (await (await request.get(base)).json()).messages.length).toBe(4);
  await page.goto(`/?chat=${chat.id}`);
  await expect(page.getByRole('button', { name: 'Fork da questo messaggio' })).toHaveCount(2);
  await expect(
    page.locator('.message.user').getByRole('button', { name: 'Fork da questo messaggio' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Fork da questo messaggio' }).first().click();
  await expect(page).not.toHaveURL(new RegExp(chat.id));
  await expect(
    page.getByRole('heading', { name: 'Origine fork · Fork', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.locator('.messages')).not.toContainText('Messaggio successivo escluso');
  await page.reload();
  await expect(page.locator('.message')).toHaveCount(2);
  const forkId = new URL(page.url()).searchParams.get('chat');
  await page.getByRole('button', { name: 'Apri menu' }).click();
  await expect(page.locator('.sidebar')).toContainText('Origine fork · Fork');
  await expect(page.locator('.sidebar')).toContainText('Origine fork');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/fork-sidebar-mobile.png', fullPage: true });
  await request.post(`/api/conversations/${forkId}/delete`, { data: {} });
  await request.post(`${base}/delete`, { data: {} });
});
