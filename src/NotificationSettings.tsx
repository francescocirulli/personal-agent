import { useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { api, type Settings } from './api';
import { notificationDeviceId } from './notifications';

type Preferences = { preview: boolean; suppressWhenActiveElsewhere: boolean };
const defaults: Preferences = { preview: false, suppressWhenActiveElsewhere: false };
export function NotificationSettings({
  settings,
  onClose,
}: {
  settings?: Settings;
  onClose(): void;
}) {
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [active, setActive] = useState(false);
  const [prefs, setPrefs] = useState(defaults);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const supported =
    typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed =
    matchMedia('(display-mode: standalone)').matches ||
    !!(navigator as Navigator & { standalone?: boolean }).standalone;
  async function refresh() {
    if (!supported) {
      setLoading(false);
      return;
    }
    setPermission(Notification.permission);
    const registration = await navigator.serviceWorker.getRegistration();
    const sub = (await registration?.pushManager.getSubscription()) ?? null;
    setSubscription(sub);
    if (sub) {
      const state = await api<{ subscribed: boolean; preferences: Preferences }>('/push/device', {
        endpoint: sub.endpoint,
        deviceId: notificationDeviceId(),
      });
      setActive(state.subscribed);
      setPrefs(state.preferences);
    } else {
      setActive(false);
      setPrefs(defaults);
    }
    setLoading(false);
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const update = () => {
      if (!document.hidden)
        void refresh().catch(() => {
          setError('Non riesco a verificare le notifiche. Chiudi e riprova.');
          setLoading(false);
        });
    };
    update();
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [pending, onClose]);
  async function action(run: () => Promise<void>) {
    if (pending) return;
    const focusTarget = document.activeElement as HTMLElement | null;
    setPending(true);
    setError('');
    setNotice('');
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operazione non riuscita. Riprova.');
    } finally {
      setPending(false);
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body) return;
        if (
          focusTarget &&
          dialog.current?.contains(focusTarget) &&
          !focusTarget.matches(':disabled')
        )
          focusTarget.focus();
        else dialog.current?.focus();
      });
    }
  }
  async function enable() {
    const granted = await Notification.requestPermission();
    setPermission(granted);
    if (granted !== 'granted') return;
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.active) throw new Error('L’app si sta preparando. Riprova tra poco.');
    const key = settings!.pushPublicKey!.replace(/-/g, '+').replace(/_/g, '/');
    const sub =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(atob(key), (char) => char.charCodeAt(0)),
      }));
    await api('/push/subscribe', { ...sub.toJSON(), deviceId: notificationDeviceId() });
    await refresh();
    setNotice('Notifiche attive su questo dispositivo.');
  }
  async function disable() {
    if (!subscription) return;
    await api('/push/unsubscribe', { endpoint: subscription.endpoint });
    setActive(false);
    await subscription.unsubscribe();
    await refresh();
    setNotice('Notifiche disattivate su questo dispositivo.');
  }
  async function save(next: Preferences) {
    if (!subscription) return;
    const previous = prefs;
    setPrefs(next);
    try {
      await api('/push/preferences', { endpoint: subscription.endpoint, ...next });
    } catch (error) {
      setPrefs(previous);
      throw error;
    }
    setNotice('Preferenze salvate.');
  }
  const needsHome = ios && !installed;
  const enabled = active && permission === 'granted';
  const status = loading
    ? 'Verifico le notifiche…'
    : needsHome
      ? 'Aggiungi l’app alla Home'
      : !supported
        ? 'Non disponibili in questo browser'
        : permission === 'denied'
          ? 'Bloccate nelle impostazioni'
          : !settings
            ? 'Carico la configurazione…'
            : !settings.pushPublicKey
              ? 'Non ancora disponibili'
              : enabled
                ? 'Attive su questo dispositivo'
                : 'Disattivate su questo dispositivo';
  return (
    <div className="modal-backdrop">
      <section
        ref={dialog}
        tabIndex={-1}
        className="modal settings-modal notification-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-title"
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            const controls = [
              ...e.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), a[href]',
              ),
            ];
            const first = controls[0],
              last = controls.at(-1);
            if (
              e.shiftKey &&
              (document.activeElement === first || document.activeElement === dialog.current)
            ) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <button
          className="modal-close icon-button"
          aria-label="Chiudi notifiche"
          disabled={pending}
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <div className="eyebrow">IMPOSTAZIONI</div>
        <h2 id="notification-title">Notifiche</h2>
        <p>Ricevi un avviso quando l’agente risponde o il lavoro si interrompe per un errore.</p>
        <div className="notification-status">
          <Bell size={20} aria-hidden="true" />
          <strong>{status}</strong>
        </div>
        {needsHome && (
          <p>
            In Safari, apri Condividi e scegli “Aggiungi alla schermata Home”. Poi apri l’app dalla
            sua icona per attivare le notifiche.
          </p>
        )}
        {!needsHome && !supported && (
          <p>
            Apri l’app in un browser che supporta le notifiche. Le risposte non lette restano
            visibili nello storico.
          </p>
        )}
        {permission === 'denied' && (
          <p>
            Consenti le notifiche nelle impostazioni del dispositivo o del browser, poi torna qui.
          </p>
        )}
        {!!settings && !settings.pushPublicKey && (
          <p>Serve completare la configurazione delle notifiche sul server.</p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <div className="notification-actions">
          <button
            className="primary"
            disabled={
              pending ||
              loading ||
              (!active &&
                (!supported || needsHome || permission === 'denied' || !settings?.pushPublicKey))
            }
            onClick={() => void action(active ? disable : enable)}
          >
            {active ? 'Disattiva su questo dispositivo' : 'Attiva su questo dispositivo'}
          </button>
          <button
            className="soft-button"
            disabled={pending || loading || !enabled || !settings?.pushPublicKey}
            onClick={() =>
              void action(async () => {
                if (!subscription) return;
                try {
                  await api('/push/test', { endpoint: subscription.endpoint });
                  setNotice('Prova inviata. Controlla le notifiche del dispositivo.');
                } finally {
                  await refresh();
                }
              })
            }
          >
            Invia una prova
          </button>
        </div>
        <fieldset disabled={pending || loading || !enabled} className="notification-preferences">
          <legend>Su questo dispositivo</legend>
          <label>
            <input
              type="checkbox"
              checked={prefs.preview}
              onChange={(e) => void action(() => save({ ...prefs, preview: e.target.checked }))}
            />
            <span>
              Mostra un’anteprima della risposta
              <small>Il testo può comparire anche nella schermata di blocco.</small>
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={prefs.suppressWhenActiveElsewhere}
              onChange={(e) =>
                void action(() => save({ ...prefs, suppressWhenActiveElsewhere: e.target.checked }))
              }
            />
            <span>
              Non avvisarmi se leggo la chat su un altro dispositivo
              <small>Se disattivato, ricevi l’avviso anche quando la chat è aperta altrove.</small>
            </span>
          </label>
        </fieldset>
        <p className="settings-note">
          Mentre guardi questa chat sul dispositivo, non ricevi avvisi per la stessa chat. Puoi
          sempre trovare le nuove risposte nello storico.
        </p>
      </section>
    </div>
  );
}
