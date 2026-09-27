import { test, expect } from '@playwright/test';

for (const width of [320, 390]) {
  test(`compact chat keeps messages visible with work, queue and repository at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const chat = await (
      await request.post('/api/conversations', {
        data: {
          agent: 'codex',
          title: 'Ottimizziamo la chat con un titolo lungo',
          repo: 'example/personal-agent',
        },
      })
    ).json();
    const base = `/api/conversations/${chat.id}`;
    await request.post(base + '/queue/pause', { data: { paused: true } });
    await request.post(base + '/turns', { data: { text: 'Pusha in main' } });
    await page.route(`**${base}`, async (route) => {
      const data = await (await route.fetch()).json();
      data.runs.push({
        id: 'running-fixture',
        status: 'running',
        created_at: Date.now() - 65000,
        updated_at: Date.now(),
      });
      data.messages = [
        {
          id: 'u',
          role: 'user',
          text: 'Riduci lo spazio occupato dai pannelli.',
          created_at: Date.now(),
        },
        {
          id: 'a',
          role: 'assistant',
          text: 'Sto verificando il layout mobile e i controlli della coda.',
          created_at: Date.now(),
        },
      ];
      data.activity = Array.from({ length: 61 }, (_, index) => ({
        id: index,
        run_id: 'running-fixture',
        text: `Verifica ${index + 1} delle modifiche`,
        created_at: Date.now(),
      }));
      await route.fulfill({ json: data });
    });
    await page.route(`**${base}/diff?*`, (route) =>
      route.fulfill({ json: { git: { ready: true }, total: 10, mode: 'local', base: null } }),
    );
    try {
      await page.goto(`/?chat=${chat.id}`);
      const queue = page.getByRole('region', { name: 'Messaggi in coda' });
      const toggle = queue.getByRole('button', { name: 'Mostra messaggi in coda' });
      const work = page.getByRole('region', { name: 'Stato del lavoro' });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(queue.getByText('Pusha in main', { exact: true }).first()).toBeVisible();
      await expect(queue.getByRole('button', { name: 'Modifica', exact: true })).toBeHidden();
      await expect(work.getByRole('button', { name: 'Apri modifiche (10)' })).toBeVisible();
      await expect(work.getByRole('button', { name: 'Ferma task' })).toBeVisible();
      expect((await queue.boundingBox())!.height).toBeLessThanOrEqual(52);
      expect((await page.locator('.composer-area').boundingBox())!.height).toBeLessThanOrEqual(180);
      expect((await work.boundingBox())!.height).toBeLessThanOrEqual(160);
      expect((await page.locator('.messages').boundingBox())!.height).toBeGreaterThan(400);
      for (const label of [
        'Allega immagini e documenti',
        'Apri modalità voce',
        'Aggiungi alla coda',
        'Repository e branch',
        'Modifiche della chat',
      ]) {
        const button = page.getByRole('button', { name: label, exact: true });
        await expect(button).toBeInViewport();
        const bounds = (await button.boundingBox())!;
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: `test-results/compact-chat-${width}.png` });
      await toggle.click();
      await expect(queue.getByRole('button', { name: 'Modifica', exact: true })).toBeVisible();
      await queue.getByRole('button', { name: 'Modifica', exact: true }).click();
      await queue
        .getByRole('textbox', { name: 'Modifica messaggio in coda' })
        .fill('Pusha dopo i test');
      await queue.getByRole('button', { name: 'Salva', exact: true }).click();
      await expect(queue).toContainText('Pusha dopo i test');
      await toggle.focus();
      await page.keyboard.press('Escape');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toBeFocused();
      const composer = page.getByRole('textbox', { name: 'Messaggio', exact: true });
      await composer.fill('Una bozza lunga\n'.repeat(15));
      expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(120);
      await composer.fill('');
      expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(48);
      await page.setViewportSize({ width, height: 500 });
      await expect(
        page.getByRole('button', { name: 'Aggiungi alla coda', exact: true }),
      ).toBeInViewport();
      expect((await page.locator('.messages').boundingBox())!.height).toBeGreaterThan(100);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.reload();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(queue.getByText('Pusha dopo i test', { exact: true }).first()).toBeVisible();
    } finally {
      await request.post(base + '/delete', { data: {} });
    }
  });
}
