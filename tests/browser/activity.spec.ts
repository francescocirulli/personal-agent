import { test, expect } from '@playwright/test';

for (const viewport of [
  { width: 320, height: 700 },
  { width: 1440, height: 900 },
]) {
  test(`activity stays closable at the end of a long list, ${viewport.width}px`, async ({
    page,
    request,
  }) => {
    const chat = await (
      await request.post('/api/conversations', {
        data: { agent: 'codex', title: 'Attività da consultare' },
      })
    ).json();
    await page.setViewportSize(viewport);
    await page.route(`**/api/conversations/${chat.id}`, async (route) => {
      const data = await (await route.fetch()).json();
      data.activity = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        conversation_id: chat.id,
        run_id: 'test',
        created_at: Date.now(),
        text: `Operazione ${i + 1}: verifica del file ${'percorso/'.repeat(12)}documento.md`,
      }));
      await route.fulfill({ json: data });
    });
    try {
      await page.goto(`/?chat=${chat.id}`);
      const toggle = page.getByRole('button', { name: 'Attività del lavoro', exact: true });
      const list = page.getByRole('region', { name: 'Elenco attività' });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(list).toBeVisible();
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(list.getByText('Operazione 100:', { exact: false })).toBeInViewport();
      await expect(toggle).toBeInViewport();
      const close = page.getByRole('button', { name: 'Chiudi attività', exact: true });
      await expect(close).toBeInViewport();
      expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `test-results/activity-${viewport.width}.png` });
      await close.click();
      await expect(list).toBeHidden();
      await expect(toggle).toBeFocused();
      await toggle.click();
      await list.focus();
      await page.keyboard.press('Escape');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toBeFocused();
      await toggle.click();
      await page.getByRole('textbox', { name: 'Messaggio', exact: true }).click();
      await expect(list).toBeHidden();
      await expect(page.getByRole('textbox', { name: 'Messaggio', exact: true })).toBeFocused();
      await toggle.click();
      await toggle.click();
      await expect(list).toBeHidden();
    } finally {
      await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
    }
  });
}

test('activity reading survives live updates without jumping; another chat starts closed', async ({
  page,
  request,
}) => {
  const chats = [];
  for (const title of ['Attività prima chat', 'Attività seconda chat']) {
    chats.push(
      await (await request.post('/api/conversations', { data: { agent: 'codex', title } })).json(),
    );
  }
  for (const chat of chats) {
    await page.route(`**/api/conversations/${chat.id}`, async (route) => {
      const data = await (await route.fetch()).json();
      data.activity = [
        ...Array.from({ length: 100 }, (_, i) => ({
          id: -i,
          conversation_id: chat.id,
          run_id: 'test',
          created_at: Date.now(),
          text: `Attività precedente ${i + 1}`,
        })),
        ...data.activity,
      ];
      await route.fulfill({ json: data });
    });
  }
  try {
    await page.goto(`/?chat=${chats[0].id}`);
    const toggle = page.getByRole('button', { name: 'Attività del lavoro', exact: true });
    const list = page.getByRole('region', { name: 'Elenco attività' });
    await toggle.click();
    await list.evaluate((el) => {
      el.scrollTop = 300;
    });
    // Track attempts to force the conversation to the bottom during a real streamed turn.
    await page.evaluate(() => {
      (window as any).bottomJumps = 0;
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args) {
        if (this.matches('.messages > div:last-child')) (window as any).bottomJumps++;
        original.apply(this, args);
      };
    });
    await request.post(`/api/conversations/${chats[0].id}/turns`, {
      data: { text: 'Aggiornamento durante la lettura' },
    });
    await expect(page.getByRole('button', { name: 'Ascolta', exact: true })).toBeVisible();
    await expect(list).toBeVisible();
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(300);
    expect(await page.evaluate(() => (window as any).bottomJumps)).toBe(0);
    await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
    await page.getByRole('button', { name: 'Attività seconda chat Codex', exact: true }).click();
    await expect(page.locator('.chat-title')).toHaveText('Attività seconda chat');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
    await page.getByRole('button', { name: 'Attività prima chat Codex', exact: true }).click();
    await expect(page.locator('.chat-title')).toHaveText('Attività prima chat');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  } finally {
    for (const chat of chats)
      await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
  }
});
