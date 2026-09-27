import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import webpush from 'web-push';
import { Store } from '../server/store';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { createNotifications, type Presence } from '../server/notifications';

function response(store: Store, chatId: string, text = 'Risposta privata') {
  const runId = randomUUID();
  store.db
    .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)')
    .run(runId, chatId, 'complete', null, Date.now(), Date.now());
  return store.addMessage(chatId, runId, 'assistant', text);
}
function pushConfig(dir: string) {
  const keys = webpush.generateVAPIDKeys();
  return {
    ...readConfig(),
    dataDir: dir,
    demo: true,
    password: '',
    vapidPublic: keys.publicKey,
    vapidPrivate: keys.privateKey,
  };
}
const subscription = (deviceId: string) => ({
  deviceId,
  endpoint: `https://web.push.apple.com/${deviceId}`,
  keys: { p256dh: 'a'.repeat(30), auth: 'b'.repeat(20) },
});

test('unread migration, concurrent replies, monotonic reads, forks and restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-unread-'));
  let store = new Store(dir);
  try {
    const chat = store.create('claude', null, 'Storico');
    const old = response(store, chat.id);
    store.db.exec('ALTER TABLE conversations DROP COLUMN read_message_seq');
    store.close();
    store = new Store(dir);
    assert.equal(store.unreadCount(), 0);
    const first = response(store, chat.id),
      second = response(store, chat.id);
    assert.equal(store.unreadCount(), 2);
    assert.ok(store.markRead(chat.id, first.id));
    assert.equal(store.unreadCount(), 1, 'reply received after rendering stays unread');
    assert.equal(store.markRead(chat.id, old.id), false, 'late read cannot move backwards');
    const other = store.create('codex', null, 'Altro');
    assert.equal(store.markRead(other.id, second.id), false);
    const fork = store.fork(chat.id, first.id);
    assert.equal(store.list().find((c) => c.id === fork.id)!.unread_count, 0);
    store.close();
    store = new Store(dir);
    assert.equal(store.unreadCount(), 1);
    store.markRead(chat.id, second.id);
    assert.equal(store.unreadCount(), 0);
    response(store, other.id);
    store.remove(other.id);
    response(store, fork.id);
    assert.equal(store.unreadCount(), 1, 'deleted messages do not hide later replies');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('push targets devices, respects presence preference, protects previews and ignores cancellation', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-push-'));
  const store = new Store(dir);
  const sent: { endpoint: string; payload: any }[] = [];
  t.mock.method(webpush, 'sendNotification', async (sub: any, payload: string) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return {};
  });
  try {
    const presence = new Map<string, Presence>();
    const service = createNotifications(store, pushConfig(dir), presence);
    const phone = subscription(randomUUID()),
      desktop = subscription(randomUUID());
    for (const sub of [phone, desktop])
      store.db
        .prepare('INSERT INTO subscriptions(endpoint,data,device_id) VALUES (?,?,?)')
        .run(sub.endpoint, JSON.stringify(sub), sub.deviceId);
    const chat = store.create('codex', null, 'Il mio progetto');
    const message = response(store, chat.id);
    presence.set('desktop', {
      deviceId: desktop.deviceId,
      conversationId: chat.id,
      visible: true,
      at: Date.now(),
    });
    await service.notify(chat, 'complete', message.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, phone.endpoint);
    assert.equal(sent[0].payload.title, 'Il mio progetto');
    assert.equal(sent[0].payload.body, 'Codex ha risposto.');
    assert.equal(sent[0].payload.unreadCount, 1);
    assert.match(sent[0].payload.url, new RegExp(message.id));
    store.db
      .prepare('UPDATE subscriptions SET preferences=? WHERE endpoint=?')
      .run(JSON.stringify({ preview: true, suppressWhenActiveElsewhere: true }), phone.endpoint);
    sent.length = 0;
    await service.notify(chat, 'complete', message.id);
    assert.equal(sent.length, 0);
    presence.get('desktop')!.at -= 60000;
    await service.notify(chat, 'complete', message.id);
    assert.equal(sent.length, 2);
    assert.match(sent.find((s) => s.endpoint === phone.endpoint)!.payload.body, /Risposta privata/);
    sent.length = 0;
    for (const status of ['cancelled', 'interrupted', 'queued', 'running'] as const)
      await service.notify(chat, status);
    assert.equal(sent.length, 0);
    await service.notify(chat, 'error');
    assert.equal(sent.length, 2);
    assert.match(sent[0].payload.body, /non ha completato/);
    assert.doesNotMatch(sent[0].payload.body, /Risposta privata/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('notification API: auth, validation, persistent preferences, targeted test, expiry, errors and real cancellation', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pa-notification-api-'));
  const config = { ...pushConfig(dir), password: 'notification-test-password' };
  let runtime = createApp(config);
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  config.origin = `http://127.0.0.1:${(server.address() as any).port}`;
  let cookie = '',
    statusCode = 0;
  const sent: any[] = [];
  t.mock.method(webpush, 'sendNotification', async (sub: any, payload: string) => {
    if (statusCode) throw { statusCode };
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return {};
  });
  const request = (url: string, body?: unknown) =>
    fetch(config.origin + '/api' + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const phone = subscription(randomUUID()),
    desktop = subscription(randomUUID());
  try {
    for (const route of ['subscribe', 'unsubscribe', 'device', 'test', 'preferences'])
      assert.equal((await request('/push/' + route, phone)).status, 401);
    cookie = (await request('/login', { password: config.password })).headers
      .get('set-cookie')!
      .split(';')[0];
    assert.equal(
      (await request('/push/subscribe', { ...phone, endpoint: 'https://example.com/push' })).status,
      400,
    );
    for (const sub of [phone, desktop])
      assert.equal((await request('/push/subscribe', sub)).status, 200);
    assert.equal(
      (await request('/push/preferences', { endpoint: phone.endpoint, preview: 'yes' })).status,
      400,
    );
    assert.equal(
      (
        await request('/push/preferences', {
          endpoint: phone.endpoint,
          preview: true,
          suppressWhenActiveElsewhere: true,
        })
      ).status,
      200,
    );
    await request('/push/subscribe', phone);
    assert.equal(
      (await (await request('/push/device', phone)).json()).preferences.preview,
      true,
      'resubscribing preserves choices',
    );
    assert.equal((await request('/push/test', phone)).status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, phone.endpoint);
    assert.equal(
      (await request('/push/test', { endpoint: 'https://web.push.apple.com/unknown' })).status,
      404,
    );
    statusCode = 503;
    assert.equal((await request('/push/test', phone)).status, 502);
    assert.equal((await (await request('/push/device', phone)).json()).subscribed, true);
    statusCode = 410;
    assert.equal((await request('/push/test', phone)).status, 410);
    assert.equal((await (await request('/push/device', phone)).json()).subscribed, false);
    const { deviceId, ...legacy } = phone;
    await request('/push/subscribe', legacy);
    assert.equal(
      runtime.store.db
        .prepare('SELECT device_id FROM subscriptions WHERE endpoint=?')
        .get(phone.endpoint)!.device_id,
      null,
    );
    await request('/push/device', phone);
    await request('/push/subscribe', legacy);
    assert.equal(
      runtime.store.db
        .prepare('SELECT device_id FROM subscriptions WHERE endpoint=?')
        .get(phone.endpoint)!.device_id,
      deviceId,
      'legacy clients preserve the device binding',
    );
    statusCode = 0;
    sent.length = 0;
    const chat = runtime.store.create('codex', null, 'Da annullare');
    const run = await (
      await request(`/conversations/${chat.id}/turns`, { text: 'Interrompi questa prova' })
    ).json();
    await request(`/conversations/${chat.id}/cancel`, {});
    for (
      let i = 0;
      i < 100 &&
      runtime.store.runs(chat.id).find((r) => r.id === run.runId)?.status !== 'cancelled';
      i++
    )
      await delay(20);
    assert.equal(runtime.store.runs(chat.id).find((r) => r.id === run.runId)?.status, 'cancelled');
    await delay(50);
    assert.equal(sent.length, 0);
    const message = response(runtime.store, chat.id);
    assert.equal(
      (await (await request(`/conversations/${chat.id}/read`, { messageId: message.id })).json())
        .unreadCount,
      0,
    );
    const reads = () =>
      runtime.store.db
        .prepare("SELECT count(*) AS n FROM events WHERE json_extract(data,'$.type')='read'")
        .get()!.n;
    const before = reads();
    await request(`/conversations/${chat.id}/read`, { messageId: message.id });
    assert.equal(reads(), before);
    await request('/push/unsubscribe', desktop);
    assert.equal((await (await request('/push/device', desktop)).json()).subscribed, false);
    await request('/push/subscribe', phone);
    await request('/push/preferences', { endpoint: phone.endpoint, preview: true });
    await runtime.close();
    runtime = createApp(config);
    assert.equal(
      JSON.parse(
        String(
          runtime.store.db
            .prepare('SELECT preferences FROM subscriptions WHERE endpoint=?')
            .get(phone.endpoint)!.preferences,
        ),
      ).preview,
      true,
    );
  } finally {
    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('service worker displays pushes, updates badges and opens the matching chat without autoplay', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const handlers = new Map<string, (event: any) => void>();
  const shown: any[] = [],
    badges: number[] = [],
    opened: string[] = [];
  let pending: Promise<unknown> | undefined;
  const worker = {
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    location: { origin: 'https://agent.example' },
    registration: {
      showNotification: async (title: string, options: any) => {
        shown.push({ title, ...options });
      },
    },
    navigator: {
      setAppBadge: async (count: number) => {
        badges.push(count);
      },
      clearAppBadge: async () => {
        badges.push(0);
      },
    },
    clients: {
      matchAll: async () => [
        {
          url: 'https://agent.example/?chat=other',
          navigate: async () => {
            throw new Error('Wrong window');
          },
        },
        {
          url: 'https://agent.example/?chat=target',
          navigate: async (url: string) => {
            opened.push(url);
          },
          focus: async () => {},
        },
      ],
      openWindow: async (url: string) => {
        opened.push(url);
      },
    },
  };
  runInNewContext(await readFile('public/sw.js', 'utf8'), { self: worker, URL });
  const payload = {
    title: 'Progetto',
    body: 'Claude Code ha risposto.',
    tag: 'target',
    url: '/?chat=target&message=response',
    unreadCount: 3,
  };
  const waitUntil = (promise: Promise<unknown>) => {
    pending = promise;
  };
  handlers.get('push')!({ data: { json: () => payload }, waitUntil });
  await pending;
  assert.equal(shown[0].title, 'Progetto');
  assert.equal(shown[0].tag, 'target');
  assert.deepEqual(badges, [3]);
  handlers.get('notificationclick')!({
    notification: { data: shown[0].data, close() {} },
    waitUntil,
  });
  await pending;
  assert.deepEqual(opened, ['https://agent.example/?chat=target&message=response']);
  handlers.get('notificationclick')!({
    notification: { data: { url: 'https://external.example' }, close() {} },
    waitUntil,
  });
  assert.equal(opened.length, 1);
  handlers.get('push')!({ data: { json: () => ({ ...payload, unreadCount: 0 }) }, waitUntil });
  await pending;
  assert.deepEqual(badges, [3, 0]);
  worker.navigator.setAppBadge = async () => {
    throw new Error('Badge denied');
  };
  handlers.get('push')!({ data: { json: () => payload }, waitUntil });
  await pending;
  assert.equal(shown.length, 3, 'badge failure does not prevent visible notification');
});
