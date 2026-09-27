import { test, expect } from '@playwright/test';

test('mobile notifications: enable, preview, presence choice, test and disable are scoped to the device', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
    let permission = 'default';
    Object.defineProperty(window, 'Notification', {
      value: {
        get permission() {
          return permission;
        },
        requestPermission: async () => {
          permission = 'granted';
          return permission;
        },
      },
    });
    Object.defineProperty(window, 'PushManager', { value: function () {} });
    let subscribed = false;
    const sub = {
      endpoint: 'https://web.push.apple.com/browser-test',
      toJSON: () => ({
        endpoint: 'https://web.push.apple.com/browser-test',
        keys: { p256dh: 'a'.repeat(30), auth: 'b'.repeat(20) },
      }),
      unsubscribe: async () => {
        subscribed = false;
        return true;
      },
    };
    Object.defineProperty(navigator.serviceWorker, 'getRegistration', {
      value: async () => ({
        active: {},
        pushManager: {
          getSubscription: async () => (subscribed ? sub : null),
          subscribe: async () => {
            subscribed = true;
            return sub;
          },
        },
      }),
    });
  });
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        demo: true,
        voiceAvailable: false,
        pushPublicKey: 'YWJj',
        maxRuns: 3,
        unrestricted: false,
      },
    }),
  );
  let subscribed = false,
    tested = 0;
  let prefs = { preview: false, suppressWhenActiveElsewhere: false };
  await page.route('**/api/push/*', (route) => {
    const kind = route.request().url().split('/').at(-1);
    const body = route.request().postDataJSON();
    if (kind === 'subscribe') {
      expect(body.deviceId).toMatch(/^[a-f0-9-]{36}$/);
      subscribed = true;
    }
    if (kind === 'unsubscribe') subscribed = false;
    if (kind === 'preferences')
      prefs = {
        preview: body.preview,
        suppressWhenActiveElsewhere: body.suppressWhenActiveElsewhere,
      };
    if (kind === 'test') {
      expect(body.endpoint).toBe('https://web.push.apple.com/browser-test');
      tested++;
    }
    return route.fulfill({
      json: kind === 'device' ? { subscribed, preferences: prefs } : { ok: true },
    });
  });
  await page.goto('/?settings=notifications');
  const panel = page.getByRole('dialog', { name: 'Notifiche', exact: true });
  await expect(panel.getByText('Disattivate su questo dispositivo', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Invia una prova' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Attiva su questo dispositivo', exact: true }).click();
  await expect(panel.getByText('Attive su questo dispositivo', { exact: true })).toBeVisible();
  const preview = panel.getByRole('checkbox', { name: /Mostra un’anteprima/ });
  await expect(preview).not.toBeChecked();
  await preview.check();
  await expect(preview).toBeChecked();
  await panel.getByRole('checkbox', { name: /Non avvisarmi/ }).check();
  await expect.poll(() => prefs).toEqual({ preview: true, suppressWhenActiveElsewhere: true });
  await panel.getByRole('button', { name: 'Invia una prova' }).click();
  await expect(panel.getByRole('status')).toContainText('Prova inviata');
  expect(tested).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/notifications-mobile.png', fullPage: true });
  await panel.getByRole('button', { name: 'Chiudi notifiche' }).click();
  await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
  await page.getByRole('button', { name: 'Notifiche', exact: true }).click();
  await expect(preview).toBeChecked();
  await panel.getByRole('button', { name: 'Disattiva su questo dispositivo' }).click();
  await expect(panel.getByText('Disattivate su questo dispositivo', { exact: true })).toBeVisible();
  expect(subscribed).toBe(false);
  await expect(panel.getByRole('button', { name: 'Chiudi notifiche' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('notifications explain blocked permissions without requesting permission', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
    Object.defineProperty(window, 'Notification', {
      value: {
        permission: 'denied',
        requestPermission: () => {
          throw new Error('Must not prompt');
        },
      },
    });
    Object.defineProperty(window, 'PushManager', { value: function () {} });
  });
  await page.goto('/?settings=notifications');
  const panel = page.getByRole('dialog', { name: 'Notifiche', exact: true });
  await expect(panel.getByText('Bloccate nelle impostazioni', { exact: true })).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Attiva su questo dispositivo', exact: true }),
  ).toBeDisabled();
  await expect(panel.getByText(/Consenti le notifiche nelle impostazioni/)).toBeVisible();
});

test('unread replies survive reload and clear across windows only after opening the chat', async ({
  page,
  context,
  request,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'setAppBadge', {
      value: async (count: number) => {
        (window as any).__badge = count;
      },
    });
    Object.defineProperty(navigator, 'clearAppBadge', {
      value: async () => {
        (window as any).__badge = 0;
      },
    });
  });
  const chat = await (
    await request.post('/api/conversations', {
      data: { agent: 'claude', title: 'Risposta da leggere' },
    })
  ).json();
  const count = async () =>
    (await (await request.get('/api/conversations')).json()).find((c: any) => c.id === chat.id)
      .unread_count;
  let other;
  try {
    await page.goto('/');
    await request.post(`/api/conversations/${chat.id}/turns`, {
      data: { text: 'Rispondi per la prova' },
    });
    await expect.poll(count).toBe(1);
    await page.reload();
    await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
    const row = page.locator('.chat-row').filter({ hasText: 'Risposta da leggere' });
    await expect(row.getByRole('img', { name: 'Una risposta non letta' })).toBeVisible();
    other = await context.newPage();
    await other.goto(`/?chat=${chat.id}`);
    await other.bringToFront();
    await expect.poll(count).toBe(0);
    await page.bringToFront();
    await expect(row.getByRole('img', { name: 'Una risposta non letta' })).toHaveCount(0);
    const total = (await (await request.get('/api/conversations')).json()).reduce(
      (sum: number, c: any) => sum + c.unread_count,
      0,
    );
    await expect.poll(() => page.evaluate(() => (window as any).__badge)).toBe(total);
  } finally {
    await other?.close();
    await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
  }
});

test('iPhone browser explains Home installation and keeps notification controls disabled', async ({
  page,
}) => {
  await page.goto('/?settings=notifications');
  const panel = page.getByRole('dialog', { name: 'Notifiche', exact: true });
  await expect(panel.getByText('Aggiungi l’app alla Home', { exact: true })).toBeVisible();
  await expect(panel.getByText(/In Safari, apri Condividi/)).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Attiva su questo dispositivo', exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
