import { useEffect, useState } from 'react';
import { Monitor, X, Download, Maximize2, Radio } from 'lucide-react';
import { api } from './api';
import type { BrowserView } from '../server/browser';

export function BrowserPanel({
  conversationId,
  beforeOpen,
}: {
  conversationId: string;
  beforeOpen(): void;
}) {
  const [open, setOpen] = useState(false),
    [view, setView] = useState<BrowserView>();
  const [frame, setFrame] = useState(''),
    [error, setError] = useState('');
  const [shotId, setShotId] = useState<string | null>(null),
    [zoom, setZoom] = useState(false);
  const base = `/conversations/${conversationId}/browser`;
  useEffect(() => {
    let disposed = false,
      running = false,
      objectUrl = '',
      controller: AbortController | undefined;
    async function update() {
      if (disposed || running || document.hidden) return;
      running = true;
      try {
        const state = await api<BrowserView>(base);
        if (disposed) return;
        setView(state);
        setError('');
        if (open && !shotId && state.tabs.length) {
          controller = new AbortController();
          const response = await fetch(`/api${base}/frame`, {
            credentials: 'same-origin',
            signal: controller.signal,
          });
          if (!response.ok) {
            if (!disposed) setError('La pagina sta cambiando. Riprovo tra un istante.');
            return;
          }
          const blob = await response.blob();
          if (disposed) return;
          const next = URL.createObjectURL(blob);
          setFrame(next);
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = next;
        } else if (!state.tabs.length) setFrame('');
      } catch (e) {
        if (!disposed && !(e instanceof DOMException && e.name === 'AbortError'))
          setError((e as Error).message);
      } finally {
        running = false;
      }
    }
    const changed = () => {
      void update();
    };
    changed();
    const timer = setInterval(changed, open ? 1200 : 6000);
    window.addEventListener('browser-change', changed);
    document.addEventListener('visibilitychange', changed);
    return () => {
      disposed = true;
      clearInterval(timer);
      controller?.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      window.removeEventListener('browser-change', changed);
      document.removeEventListener('visibilitychange', changed);
    };
  }, [base, open, shotId]);
  const shot = view?.screenshots.find((s) => s.id === shotId);
  const source = shot ? `/api${base}/screenshots/${shot.id}` : frame;
  return (
    <>
      <button
        className={`browser-open ${view?.status === 'working' ? 'browser-working' : ''}`}
        aria-label="Apri browser della chat"
        onClick={() => {
          beforeOpen();
          setOpen(true);
          setShotId(null);
        }}
      >
        <Monitor size={18} /> <span>Browser</span>
        {view?.status === 'working' && <span className="status-dot" />}
      </button>
      {open && (
        <div className="modal-backdrop browser-backdrop">
          <section
            className="modal browser-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="browser-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="Chiudi browser"
              onClick={() => {
                setOpen(false);
                setFrame('');
              }}
            >
              <X size={22} />
            </button>
            <h2 id="browser-title">Browser della chat</h2>
            <p className="browser-explanation">
              Guarda la pagina mentre l’agente naviga. La vista si aggiorna circa ogni secondo; i
              comandi li dai in chat.
            </p>
            <div className="browser-toolbar">
              <button
                className={`soft-button ${!shot ? 'selected' : ''}`}
                onClick={() => setShotId(null)}
              >
                <Radio size={16} /> Vista attuale
              </button>
              <button
                className="soft-button"
                aria-pressed={zoom}
                onClick={() => setZoom((v) => !v)}
              >
                <Maximize2 size={16} /> {zoom ? 'Adatta' : 'Ingrandisci'}
              </button>
              {shot && (
                <a className="soft-button" href={source} download={`screenshot-${shot.id}.jpg`}>
                  <Download size={16} /> Scarica
                </a>
              )}
            </div>
            <div className="browser-address" title={shot?.url || view?.url}>
              {shot?.url || view?.url || 'Nessuna pagina aperta'}
            </div>
            <div className="browser-action" role="status">
              {shot
                ? `Screenshot · ${new Date(shot.createdAt).toLocaleString('it-IT')}`
                : view?.action || 'Carico il browser…'}
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className={`browser-screen ${zoom ? 'browser-zoom' : ''}`}>
              {source ? (
                <img
                  src={source}
                  alt={
                    shot
                      ? 'Screenshot salvato della pagina'
                      : 'Vista attuale del browser dell’agente'
                  }
                />
              ) : (
                <div className="browser-empty">
                  <Monitor size={36} />
                  <p>
                    {view?.tabs.length
                      ? 'Carico la vista della pagina…'
                      : 'Chiedi all’agente di aprire un sito: lo vedrai qui.'}
                  </p>
                </div>
              )}
            </div>
            {!shot && !!view?.tabs.length && (
              <small>
                {view.tabs.length} {view.tabs.length === 1 ? 'scheda aperta' : 'schede aperte'} ·{' '}
                {view.title || 'Pagina corrente'}
              </small>
            )}
            {!!view?.screenshots.length && (
              <div className="browser-gallery" aria-label="Screenshot salvati">
                <h3>Screenshot salvati</h3>
                <div>
                  {[...view.screenshots].reverse().map((s) => (
                    <button
                      key={s.id}
                      aria-label={`Apri screenshot ${new Date(s.createdAt).toLocaleTimeString('it-IT')}`}
                      aria-pressed={shotId === s.id}
                      onClick={() => setShotId(s.id)}
                    >
                      <img src={`/api${base}/screenshots/${s.id}`} loading="lazy" alt="" />
                      <span>{new Date(s.createdAt).toLocaleTimeString('it-IT')}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
