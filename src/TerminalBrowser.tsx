import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from './api';
import type { BrowserView, BrowserInput } from '../server/browser';

export function TerminalBrowser({ initialUrl, onClose }: { initialUrl: string; onClose(): void }) {
  const [view, setView] = useState<BrowserView>();
  const [address, setAddress] = useState(initialUrl),
    [text, setText] = useState('');
  const [frame, setFrame] = useState(''),
    [frameTab, setFrameTab] = useState('');
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const [secret, setSecret] = useState(true),
    [zoom, setZoom] = useState(false);
  const busy = useRef(false);
  const base = '/terminal/browser';
  useEffect(() => {
    let disposed = false,
      refreshing = false,
      imageUrl = '';
    const controller = new AbortController();
    async function refresh() {
      if (disposed || refreshing || busy.current || document.hidden) return;
      refreshing = true;
      try {
        const current = await api<BrowserView>(base);
        if (disposed) return;
        setView(current);
        const tab = current.tabs.find((t) => t.selected)?.id;
        if (tab) {
          const response = await fetch(`/api${base}/frame`, { signal: controller.signal });
          if (!response.ok) throw new Error('Immagine non disponibile. Riprovo tra poco.');
          const blob = await response.blob();
          if (disposed || busy.current) return;
          const next = URL.createObjectURL(blob);
          setFrame(next);
          setFrameTab(tab);
          if (imageUrl) URL.revokeObjectURL(imageUrl);
          imageUrl = next;
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      } finally {
        refreshing = false;
      }
    }
    async function start() {
      if (initialUrl) {
        busy.current = true;
        setPending(true);
        try {
          await api(base + '/input', { type: 'navigate', url: initialUrl });
        } catch (e) {
          if (!disposed) setError((e as Error).message);
        } finally {
          busy.current = false;
          if (!disposed) setPending(false);
        }
      }
      await refresh();
    }
    void start();
    const timer = setInterval(() => void refresh(), 1200);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [initialUrl]);
  async function send(input: BrowserInput) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      setView(await api<BrowserView>(base + '/input', input));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const tab = view?.tabs.find((t) => t.selected)?.id || '';
  const ready = !!tab && !pending && frameTab === tab;
  return createPortal(
    <div className="modal-backdrop terminal-browser-backdrop">
      <section
        className="modal terminal-browser-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Browser del terminale"
      >
        <button
          className="modal-close icon-button"
          aria-label="Chiudi browser del terminale"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <h2>Browser del terminale</h2>
        <p>
          Completa qui il login della CLI. Tocca la pagina per scegliere un campo, poi invia il
          testo. La sessione è separata dal browser del telefono e dalle chat.
        </p>
        <form
          className="browser-navigation"
          onSubmit={(e) => {
            e.preventDefault();
            void send({ type: 'navigate', url: address });
          }}
        >
          <input
            aria-label="Indirizzo browser terminale"
            type="url"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="https://…"
            required
            autoCapitalize="none"
            autoCorrect="off"
          />
          <button disabled={pending}>Apri indirizzo</button>
        </form>
        <p className="browser-address">{view?.url || 'Nessuna pagina aperta'}</p>
        {!!view?.tabs.length && (
          <select
            aria-label="Scheda browser terminale"
            value={tab}
            disabled={pending}
            onChange={(e) => void send({ type: 'tab', id: e.target.value })}
          >
            {view.tabs.map((t, i) => (
              <option value={t.id} key={t.id}>
                Scheda {i + 1} · {t.url}
              </option>
            ))}
          </select>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {pending && <p role="status">Azione in corso…</p>}
        {view?.dialog && (
          <div>
            <p>{view.dialog.message}</p>
            <button
              disabled={pending}
              onClick={() => void send({ type: 'dialog', accept: true, text })}
            >
              Conferma dialogo
            </button>
            <button disabled={pending} onClick={() => void send({ type: 'dialog', accept: false })}>
              Annulla dialogo
            </button>
          </div>
        )}
        <button onClick={() => setZoom(!zoom)}>
          {zoom ? 'Adatta allo schermo' : 'Ingrandisci pagina'}
        </button>
        <div className={`interactive-browser-viewport ${zoom ? 'zoomed' : ''}`}>
          {frame && (
            <button
              className="interactive-browser-screen"
              aria-label="Pagina interattiva del browser"
              disabled={!ready}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                void send({
                  type: 'click',
                  x: Math.max(0, Math.min(1280, ((e.clientX - rect.left) / rect.width) * 1280)),
                  y: Math.max(0, Math.min(800, ((e.clientY - rect.top) / rect.height) * 800)),
                  tab: frameTab,
                });
              }}
            >
              <img src={frame} alt="Pagina del browser del terminale" draggable={false} />
            </button>
          )}
        </div>
        <div className="terminal-keys">
          <button disabled={!ready} onClick={() => void send({ type: 'back' })}>
            Indietro
          </button>
          <button disabled={!ready} onClick={() => void send({ type: 'scroll', delta: -550, tab })}>
            Scorri su
          </button>
          <button disabled={!ready} onClick={() => void send({ type: 'scroll', delta: 550, tab })}>
            Scorri giù
          </button>
          {(
            [
              'Tab',
              'Shift+Tab',
              'Enter',
              'Backspace',
              'Escape',
              'ArrowDown',
              'ArrowUp',
              'Space',
              'ControlOrMeta+A',
            ] as const
          ).map((key) => (
            <button
              key={key}
              disabled={!ready}
              onClick={() => void send({ type: 'key', key, tab })}
            >
              {key === 'ControlOrMeta+A' ? 'Seleziona tutto' : key}
            </button>
          ))}
        </div>
        <form
          className="browser-navigation"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && text) {
              void send({ type: 'text', text, tab });
              setText('');
            }
          }}
        >
          <input
            aria-label="Testo per il campo selezionato"
            type={secret ? 'password' : 'text'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="Testo per il campo selezionato"
          />
          <button disabled={!ready || !text}>Invia testo al browser</button>
        </form>
        <label>
          <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />{' '}
          Nascondi testo
        </label>
        <p className="settings-note">
          Se il provider rifiuta il browser integrato, usa il login browserless della CLI e apri il
          link nel browser del telefono.
        </p>
        {view?.url && /^https?:/.test(view.url) && (
          <a href={view.url} target="_blank" rel="noreferrer">
            Apri sul dispositivo
          </a>
        )}
      </section>
    </div>,
    document.body,
  );
}
