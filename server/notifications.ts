import { Router } from 'express';
import webpush from 'web-push';
import { z } from 'zod';
import type { Config } from './config';
import type { Store, Conversation, RunStatus } from './store';

export type Presence = {
  conversationId: string | null;
  visible: boolean;
  at: number;
  deviceId?: string;
};
export const notificationPreferences = z.object({
  preview: z.boolean().default(false),
  suppressWhenActiveElsewhere: z.boolean().default(false),
});
export class NotificationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const endpointInput = z.object({ endpoint: z.string().url().max(3000) });
const subscriptionInput = endpointInput.extend({
  keys: z.object({ p256dh: z.string().min(20).max(300), auth: z.string().min(10).max(200) }),
  deviceId: z.string().uuid().optional(),
});

export function createNotifications(store: Store, config: Config, presence: Map<string, Presence>) {
  const enabled = !!(config.vapidPublic && config.vapidPrivate);
  if (enabled)
    webpush.setVapidDetails(config.vapidSubject, config.vapidPublic, config.vapidPrivate);
  for (const [name, sql] of [
    ['preferences', "ALTER TABLE subscriptions ADD COLUMN preferences TEXT NOT NULL DEFAULT '{}'"],
    ['device_id', 'ALTER TABLE subscriptions ADD COLUMN device_id TEXT'],
  ]) {
    if (
      !store.db
        .prepare('PRAGMA table_info(subscriptions)')
        .all()
        .some((c) => c.name === name)
    )
      store.db.exec(sql);
  }
  const router = Router();
  const defaults = notificationPreferences.parse({});
  const preferences = (row: Record<string, unknown>) => {
    try {
      return notificationPreferences.parse(JSON.parse(String(row.preferences)));
    } catch {
      return defaults;
    }
  };
  const requireEnabled = () => {
    if (!enabled)
      throw new NotificationError(
        503,
        'Le notifiche non sono ancora disponibili. Serve completare la configurazione del server.',
      );
  };
  const lookup = (endpoint: string) => {
    const row = store.db.prepare('SELECT * FROM subscriptions WHERE endpoint=?').get(endpoint);
    if (!row)
      throw new NotificationError(
        404,
        'Le notifiche non sono attive su questo dispositivo. Attivale di nuovo.',
      );
    return row;
  };
  async function send(row: Record<string, unknown>, payload: object) {
    try {
      await webpush.sendNotification(JSON.parse(String(row.data)), JSON.stringify(payload), {
        TTL: 3600,
        timeout: 10000,
      });
    } catch (error: any) {
      if ([404, 410].includes(error.statusCode)) {
        store.db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(String(row.endpoint));
        throw new NotificationError(
          410,
          'La registrazione è scaduta. Attiva di nuovo le notifiche.',
        );
      }
      throw new NotificationError(502, 'Invio non riuscito. Riprova tra poco.');
    }
  }
  router.post('/device', (req, res) => {
    const { endpoint, deviceId } = endpointInput
      .extend({ deviceId: z.string().uuid().optional() })
      .parse(req.body);
    const row = store.db.prepare('SELECT * FROM subscriptions WHERE endpoint=?').get(endpoint);
    // Bind subscriptions created before device-specific presence was introduced.
    if (row && deviceId && row.device_id !== deviceId)
      store.db
        .prepare('UPDATE subscriptions SET device_id=? WHERE endpoint=?')
        .run(deviceId, endpoint);
    res.json({ subscribed: !!row, preferences: row ? preferences(row) : defaults });
  });
  router.post('/subscribe', (req, res) => {
    requireEnabled();
    const { deviceId, ...sub } = subscriptionInput.parse(req.body);
    const url = new URL(sub.endpoint);
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      !['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'].some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    )
      throw new NotificationError(400, 'Servizio notifiche non supportato.');
    store.db
      .prepare(
        `INSERT INTO subscriptions(endpoint,data,device_id) VALUES (?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET data=excluded.data,device_id=coalesce(excluded.device_id,subscriptions.device_id)`,
      )
      .run(sub.endpoint, JSON.stringify(sub), deviceId ?? null);
    res.json({ ok: true });
  });
  router.post('/unsubscribe', (req, res) => {
    const { endpoint } = endpointInput.parse(req.body);
    store.db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(endpoint);
    res.json({ ok: true });
  });
  router.post('/preferences', (req, res) => {
    const { endpoint } = endpointInput.parse(req.body);
    const prefs = notificationPreferences.parse(req.body);
    lookup(endpoint);
    store.db
      .prepare('UPDATE subscriptions SET preferences=? WHERE endpoint=?')
      .run(JSON.stringify(prefs), endpoint);
    res.json(prefs);
  });
  router.post('/test', async (req, res) => {
    requireEnabled();
    const { endpoint } = endpointInput.parse(req.body);
    await send(lookup(endpoint), {
      title: 'Personal Agent',
      body: 'Le notifiche funzionano su questo dispositivo.',
      url: '/?settings=notifications',
      tag: 'notification-test',
      unreadCount: store.unreadCount(),
    });
    res.json({ ok: true });
  });
  async function notify(chat: Conversation, status: RunStatus, messageId?: string) {
    if (!enabled || !['complete', 'error'].includes(status)) return;
    const current = store.conversation(chat.id);
    if (!current) return;
    const message = messageId ? store.messages(chat.id).find((m) => m.id === messageId) : undefined;
    const agent = chat.agent === 'claude' ? 'Claude Code' : 'Codex';
    const active = [...presence.values()].filter(
      (p) => p.visible && p.conversationId === chat.id && Date.now() - p.at < 45000,
    );
    const unreadCount = store.unreadCount();
    await Promise.allSettled(
      store.db
        .prepare('SELECT * FROM subscriptions')
        .all()
        .map(async (row) => {
          const prefs = preferences(row);
          if (
            active.some(
              (p) =>
                (row.device_id && p.deviceId === row.device_id) ||
                prefs.suppressWhenActiveElsewhere,
            )
          )
            return;
          const summary =
            status === 'error'
              ? `${agent} non ha completato il lavoro. Apri la chat per i dettagli.`
              : `${agent} ha risposto.`;
          const preview =
            prefs.preview && message
              ? (message.voice_text || message.text).replace(/\s+/g, ' ').trim().slice(0, 160)
              : '';
          await send(row, {
            title: current.title,
            body: preview ? `${summary} ${preview}` : summary,
            url: `/?chat=${chat.id}${messageId ? `&message=${messageId}` : ''}`,
            tag: chat.id,
            unreadCount,
          });
        }),
    );
  }
  return { router, notify };
}
