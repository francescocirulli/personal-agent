import { SettingsTabs } from './SettingsTabs';
import { useEffect, useState } from 'react';
import { ExternalLink, Plug, Trash2, X } from 'lucide-react';
import { api } from './api';
import type { McpView } from '../server/mcp';

export function McpConnections({
  open,
  onOpen,
  onClose,
  onVoiceSettings,
  onSkillsSettings,
  onTerminalSettings,
  onExperimentalSettings,
  beforeOpen,
  showSummary = true,
}: {
  open: boolean;
  onOpen(): void;
  onClose(): void;
  onVoiceSettings(): void;
  onSkillsSettings(): void;
  onTerminalSettings(): void;
  onExperimentalSettings(): void;
  beforeOpen(): void;
  showSummary?: boolean;
}) {
  const [connections, setConnections] = useState<McpView[]>([]);
  const [name, setName] = useState(''),
    [url, setUrl] = useState('');
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const [returns, setReturns] = useState<Record<string, string>>({});
  const base = '/mcp';
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      if (document.hidden) return;
      try {
        const data = await api<McpView[]>(base);
        if (!disposed) setConnections(data);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    }
    const changed = () => {
      void refresh();
    };
    changed();
    window.addEventListener('mcp-change', changed);
    window.addEventListener('focus', changed);
    document.addEventListener('visibilitychange', changed);
    const timer = setInterval(changed, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('mcp-change', changed);
      window.removeEventListener('focus', changed);
      document.removeEventListener('visibilitychange', changed);
    };
  }, [base]);
  async function action(endpoint: string, body: unknown) {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await api(base + endpoint, body);
      setConnections(await api<McpView[]>(base));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setPending(false);
    }
  }
  function show() {
    beforeOpen();
    onOpen();
  }
  const waiting = connections.filter(
    (c) => c.enabled !== false && c.status === 'authorization_required',
  );
  const connected = connections.filter(
    (c) => c.enabled !== false && c.status === 'connected',
  ).length;
  function loginLink(c: McpView) {
    return (
      c.authorizationUrl && (
        <a
          className="soft-button mcp-login"
          href={c.authorizationUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={beforeOpen}
        >
          <ExternalLink size={16} /> Accedi al servizio<span className="sr-only"> {c.name}</span>
        </a>
      )
    );
  }
  return (
    <>
      {showSummary && (
        <div className="mcp-strip">
          <button className="text-button" onClick={show}>
            <Plug size={16} /> Collegamenti MCP{connected > 0 ? ` · ${connected} collegati` : ''}
          </button>
          {connections.some((c) => c.enabled !== false && c.status === 'error') && (
            <button className="text-button" onClick={show}>
              Accesso da verificare
            </button>
          )}
        </div>
      )}
      {showSummary &&
        !open &&
        waiting.map((c) => (
          <div className="banner notice mcp-pending" key={c.id} role="status">
            <span>
              <strong>{c.name}</strong> richiede il tuo accesso.
            </span>
            {loginLink(c)}
            <button className="text-button" onClick={show}>
              Altre opzioni
            </button>
          </div>
        ))}
      {open && (
        <div className="modal-backdrop" onClick={() => onClose()}>
          <section
            className="modal mcp-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mcp-heading"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Chiudi collegamenti MCP"
              onClick={() => onClose()}
            >
              <X size={20} />
            </button>
            <h2 id="mcp-heading">Collegamenti MCP</h2>
            <SettingsTabs
              current="mcp"
              onTab={(tab) => {
                if (tab === 'voice') onVoiceSettings();
                if (tab === 'skills') onSkillsSettings();
                if (tab === 'terminal') onTerminalSettings();
                if (tab === 'experiments') onExperimentalSettings();
              }}
            />
            <p>
              Gestisci e abilita i servizi per Claude Code e Codex. Ogni nuova chat può usare le
              disponibilità globali oppure una selezione personalizzata.
            </p>
            {!connections.length && !error && (
              <p className="settings-note">
                Nessun servizio collegato. Aggiungi il primo qui sotto.
              </p>
            )}
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <div className="mcp-list">
              {connections.map((c) => (
                <article className="mcp-card" key={c.id}>
                  <div className="mcp-card-heading">
                    <strong>{c.name}</strong>
                    <button
                      className="icon-button"
                      aria-label={`Scollega ${c.name}`}
                      disabled={pending || c.status === 'connecting'}
                      onClick={() => setRemoveId(c.id)}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                  <small className="mcp-url">{c.url}</small>
                  <label className="tool-choice">
                    <input
                      type="checkbox"
                      checked={c.enabled !== false}
                      disabled={pending}
                      onChange={(e) =>
                        void action(`/${c.id}/enabled`, { enabled: e.target.checked })
                      }
                    />
                    Abilita globalmente {c.name}
                  </label>
                  {removeId === c.id && (
                    <div
                      className="mcp-disconnect"
                      role="group"
                      aria-label={`Conferma scollegamento ${c.name}`}
                    >
                      <p>
                        Scollegare {c.name} da tutte le chat? Il consenso sul sito del servizio
                        resta invariato.
                      </p>
                      <button
                        className="quiet"
                        disabled={pending}
                        onClick={() => setRemoveId(null)}
                      >
                        Annulla
                      </button>
                      <button
                        className="soft-button"
                        disabled={pending}
                        onClick={() =>
                          void action(`/${c.id}/delete`, {}).then((ok) => {
                            if (ok) setRemoveId(null);
                          })
                        }
                      >
                        Scollega da tutte le chat
                      </button>
                    </div>
                  )}
                  {c.status === 'connected' && (
                    <p className="mcp-success" role="status">
                      {c.enabled === false
                        ? 'Collegato · disabilitato globalmente.'
                        : 'Collegato · disponibile nelle chat che lo includono.'}
                    </p>
                  )}
                  {c.status === 'connecting' && <p role="status">Verifico il collegamento…</p>}
                  {c.error && (
                    <p className="form-error" role="alert">
                      {c.error}
                    </p>
                  )}
                  {c.status === 'connected' && (
                    <button
                      className="text-button"
                      disabled={pending}
                      onClick={() => void action(`/${c.id}/login`, { mode: 'automatic' })}
                    >
                      Verifica collegamento
                    </button>
                  )}
                  {loginLink(c)}
                  {c.status !== 'connected' && c.status !== 'connecting' && (
                    <>
                      <button
                        className="text-button"
                        disabled={pending}
                        onClick={() => void action(`/${c.id}/login`, { mode: 'automatic' })}
                      >
                        Riprova login automatico
                      </button>
                      <details className="mcp-manual" open={c.mode === 'manual' || undefined}>
                        <summary>Usa copia e incolla</summary>
                        <p>
                          Se hai già autorizzato l’accesso, incolla qui l’indirizzo completo della
                          pagina finale. Non inviarlo come messaggio in chat.
                        </p>
                        {c.authorizationUrl && (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              const pasted = returns[c.id] || '';
                              setReturns((v) => ({ ...v, [c.id]: '' }));
                              void action(`/${c.id}/complete`, { url: pasted });
                            }}
                          >
                            <label>
                              Indirizzo dopo il login
                              <input
                                className="settings-input"
                                type="url"
                                autoComplete="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                value={returns[c.id] || ''}
                                onChange={(e) =>
                                  setReturns((v) => ({ ...v, [c.id]: e.target.value }))
                                }
                                placeholder="Incolla l’URL completo"
                                required
                              />
                            </label>
                            <button
                              className="soft-button"
                              disabled={pending || !returns[c.id]?.trim()}
                            >
                              Completa collegamento
                            </button>
                          </form>
                        )}
                        <p>
                          Se il servizio rifiuta il ritorno all’app, avvia un nuovo login manuale.
                          Dopo l’accesso, la pagina localhost potrebbe non aprirsi: copia comunque
                          il suo indirizzo.
                        </p>
                        <button
                          className="soft-button"
                          disabled={pending}
                          onClick={() => void action(`/${c.id}/login`, { mode: 'manual' })}
                        >
                          Avvia login manuale
                        </button>
                      </details>
                    </>
                  )}
                </article>
              ))}
            </div>
            <form
              className="mcp-add"
              onSubmit={(e) => {
                e.preventDefault();
                void action('', { name, url }).then((ok) => {
                  if (ok) {
                    setName('');
                    setUrl('');
                  }
                });
              }}
            >
              <h3>Aggiungi un servizio</h3>
              <label>
                Nome del collegamento
                <input
                  className="settings-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}"
                  maxLength={50}
                  autoCapitalize="none"
                  placeholder="es. notion"
                  required
                />
              </label>
              <label>
                Indirizzo del server MCP
                <input
                  className="settings-input"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  autoCapitalize="none"
                  autoComplete="off"
                  placeholder="https://…/mcp"
                  required
                />
              </label>
              <button className="primary" disabled={pending}>
                {pending ? 'Collegamento in corso…' : 'Collega servizio'}
              </button>
              <small>
                Server remoti HTTP con OAuth o senza login. Per servizi con registrazione OAuth
                obbligatoria può servire una configurazione dedicata.
              </small>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
