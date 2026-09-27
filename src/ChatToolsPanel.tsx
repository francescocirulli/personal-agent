import { useEffect, useState } from 'react';
import { ExternalLink, Plug, X } from 'lucide-react';
import { api, type Chat } from './api';
import type { ChatToolsView } from '../server/chat-tools';

export function ChatToolsPanel({
  chat,
  beforeOpen,
  onGlobalSettings,
}: {
  chat: Chat;
  beforeOpen(): void;
  onGlobalSettings(tab: 'mcp' | 'skills'): void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ChatToolsView>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    async function refresh() {
      if (document.hidden) return;
      const request = ++sequence;
      setLoading(true);
      try {
        const next = await api<ChatToolsView>(`/conversations/${chat.id}/tools`);
        if (!disposed && request === sequence) {
          setView(next);
          setError('');
        }
      } catch (e) {
        if (!disposed && request === sequence) {
          setView(undefined);
          setError((e as Error).message);
        }
      } finally {
        if (!disposed && request === sequence) setLoading(false);
      }
    }
    void refresh();
    const events = ['mcp-change', 'skills-change', 'chat-tools-change', 'focus'];
    for (const event of events) window.addEventListener(event, refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      for (const event of events) window.removeEventListener(event, refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [chat.id, open, retry]);
  const current = !loading && !error && view?.conversationId === chat.id ? view : undefined;
  const mcpCount = current?.mcp.filter((item) => item.available).length ?? 0;
  const skillCount =
    (current?.skills.filter((item) => item.available).length ?? 0) +
    (current?.project.skills.length ?? 0);
  const projectPending = !!chat.repo && !current?.project.ready;
  const summary = current
    ? `${mcpCount} MCP · ${skillCount} skill${projectPending ? ' · progetto da rilevare' : ''}`
    : error
      ? 'stato non disponibile'
      : 'caricamento…';
  const attention =
    current?.mcp.filter(
      (item) =>
        item.selected &&
        item.enabled !== false &&
        (item.status === 'authorization_required' || item.status === 'error'),
    ) ?? [];
  function settings(tab: 'mcp' | 'skills') {
    setOpen(false);
    beforeOpen();
    onGlobalSettings(tab);
  }
  function login(item: ChatToolsView['mcp'][number]) {
    return (
      item.authorizationUrl && (
        <a
          className="soft-button"
          href={item.authorizationUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={beforeOpen}
        >
          <ExternalLink size={16} /> Accedi al servizio {item.name}
        </a>
      )
    );
  }
  function list(
    items: (ChatToolsView['mcp'][number] | ChatToolsView['skills'][number])[],
    kind: 'mcp' | 'skills',
  ) {
    const available = items.filter((item) => item.available);
    const excluded = items.filter((item) => !item.available);
    const selected = current!.selection[kind];
    const missing = selected?.filter((id) => !items.some((item) => item.id === id)).length ?? 0;
    return (
      <>
        <p className="settings-note">
          {selected === null
            ? 'Segue le disponibilità globali.'
            : 'Selezione personalizzata per questa chat.'}
        </p>
        {available.length === 0 && (
          <p>
            Nessun {kind === 'mcp' ? 'MCP disponibile' : 'elemento globale disponibile'} in questa
            chat.
          </p>
        )}
        {available.map((item) => (
          <article className="skill-card" key={item.id}>
            <strong>{item.name}</strong>
            <p>Disponibile in questa chat</p>
            {'description' in item && <small>{item.description}</small>}
          </article>
        ))}
        {(excluded.length > 0 || missing > 0) && (
          <details className="chat-tools-excluded">
            <summary>Non disponibili in questa chat · {excluded.length + missing}</summary>
            {excluded.map((item) => (
              <article className="skill-card" key={item.id}>
                <strong>{item.name}</strong>
                <p>{item.reason}</p>
                {'status' in item && item.selected && item.enabled !== false && login(item)}
              </article>
            ))}
            {missing > 0 && (
              <p>
                {missing} elementi selezionati non sono più presenti nelle impostazioni globali.
              </p>
            )}
          </details>
        )}
      </>
    );
  }
  return (
    <>
      <div className="mcp-strip">
        <button
          className="text-button"
          onClick={() => {
            beforeOpen();
            setOpen(true);
          }}
        >
          <Plug size={16} /> MCP e skill della chat · {summary}
        </button>
      </div>
      {!open &&
        attention.map((item) => (
          <div className="banner notice mcp-pending" key={item.id} role="status">
            <span>
              <strong>{item.name}</strong>{' '}
              {item.status === 'authorization_required'
                ? 'richiede il tuo accesso.'
                : 'richiede una verifica del collegamento.'}
            </span>
            {login(item)}
            <button className="text-button" onClick={() => settings('mcp')}>
              Gestisci collegamenti globali
            </button>
          </div>
        ))}
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <section
            className="modal skills-modal chat-tools-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-tools-heading"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Chiudi strumenti della chat"
              onClick={() => setOpen(false)}
            >
              <X size={20} />
            </button>
            <h2 id="chat-tools-heading">MCP e skill della chat</h2>
            <p>
              {chat.title} · {chat.agent === 'codex' ? 'Codex' : 'Claude Code'}
            </p>
            <p>
              Disponibilità per il prossimo messaggio. Questo elenco non indica quali strumenti
              l’agente ha già utilizzato.
            </p>
            {loading && <p role="status">Aggiorno gli strumenti della chat…</p>}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <button
              className="soft-button"
              disabled={loading}
              onClick={() => setRetry((n) => n + 1)}
            >
              Aggiorna elenco
            </button>
            {current && (
              <>
                <h3>MCP · {mcpCount} disponibili</h3>
                {list(current.mcp, 'mcp')}
                <h3>
                  Skill globali · {current.skills.filter((item) => item.available).length}{' '}
                  disponibili
                </h3>
                {list(current.skills, 'skills')}
                <h3>Skill del progetto</h3>
                {!chat.repo ? (
                  <p>Questa chat non ha un repository.</p>
                ) : !current.project.ready ? (
                  <p>
                    Elenco non ancora disponibile: il repository viene preparato al primo messaggio.
                  </p>
                ) : current.project.skills.length === 0 ? (
                  <p>Nessuna skill trovata nel repository.</p>
                ) : null}
                {current.project.skills.map((item) => (
                  <article className="skill-card" key={item.id}>
                    <strong>{item.name}</strong>
                    <p>{item.description}</p>
                    <small>{item.path}</small>
                  </article>
                ))}
                {current.project.warnings.map((warning) => (
                  <p key={warning} className="settings-note">
                    {warning}
                  </p>
                ))}
                <p className="settings-note">
                  Le skill del progetto sono disponibili a entrambi gli agenti. Il browser integrato
                  è sempre disponibile e non è incluso nel conteggio MCP.
                </p>
                <p className="settings-note">
                  I cambiamenti alle skill valgono dal prossimo messaggio; un lavoro già avviato
                  conserva il suo catalogo.
                </p>
              </>
            )}
            <div className="skill-actions">
              <button className="soft-button" onClick={() => settings('mcp')}>
                Gestisci MCP globali
              </button>
              <button className="soft-button" onClick={() => settings('skills')}>
                Gestisci skill globali
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
