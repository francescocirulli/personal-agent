import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { AgentAccounts } from '../server/agent-accounts';
import { api } from './api';
import { AgentLogo } from './AgentLogo';

const statusLabel = {
  connected: 'Accesso configurato',
  signed_out: 'Non connesso',
  unavailable: 'Stato non disponibile',
  demo: 'Dimostrazione',
};

export function AccountProfile() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AgentAccounts>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const sequence = useRef(0);

  async function refresh() {
    const request = ++sequence.current;
    setLoading(true);
    setData(undefined);
    setError('');
    try {
      const next = await api<AgentAccounts>('/agent-accounts');
      if (request === sequence.current) setData(next);
    } catch {
      if (request === sequence.current) setError('Impossibile leggere gli account. Riprova.');
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      void refresh();
    }
    return () => {
      ++sequence.current;
    };
  }, [open]);
  function close() {
    ++sequence.current;
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="profile"
        aria-label="Account e abbonamenti"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="avatar">TU</span>
        <span>
          Spazio personale<small>Claude Code · Codex</small>
        </span>
      </button>
      {open &&
        createPortal(
          <dialog
            ref={dialog}
            className="branch-sheet account-sheet"
            aria-labelledby="account-title"
            onCancel={(event) => {
              event.preventDefault();
              close();
            }}
            onClick={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <div className="branch-sheet-content">
              <header>
                <h2 id="account-title">Account e abbonamenti</h2>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Chiudi account"
                  onClick={close}
                >
                  <X size={22} />
                </button>
              </header>
              <div className="branch-sheet-scroll">
                <p>
                  Account configurati sul server per Claude Code e Codex. Piano e identità sono
                  quelli comunicati dalle CLI; la validità dell’abbonamento non viene verificata
                  online.
                </p>
                {loading && (
                  <p role="status">
                    <LoaderCircle size={16} className="spin" /> Lettura degli account…
                  </p>
                )}
                {error && <p role="alert">{error}</p>}
                {data?.accounts.map((account) => (
                  <section
                    className="account-card"
                    key={account.agent}
                    aria-label={account.agent === 'claude' ? 'Claude Code' : 'Codex'}
                  >
                    <h3>
                      <AgentLogo agent={account.agent} />{' '}
                      {account.agent === 'claude' ? 'Claude Code' : 'Codex'}
                    </h3>
                    <p>{statusLabel[account.status]}</p>
                    {account.status === 'connected' && (
                      <>
                        <dl>
                          <dt>Account</dt>
                          <dd>{account.email || 'Identità non comunicata dalla CLI'}</dd>
                          <dt>Piano</dt>
                          <dd>{account.plan || 'Non comunicato dalla CLI'}</dd>
                          <dt>Accesso</dt>
                          <dd>{account.method || 'Non comunicato dalla CLI'}</dd>
                          {account.organization && (
                            <>
                              <dt>Organizzazione</dt>
                              <dd>{account.organization}</dd>
                            </>
                          )}
                        </dl>
                        {account.agent === 'codex' && account.method !== 'ChatGPT' && (
                          <p>Le chat Codex dell’app richiedono l’accesso tramite ChatGPT.</p>
                        )}
                      </>
                    )}
                    {account.status === 'signed_out' && (
                      <p>Nessun account collegato alla CLI sul server.</p>
                    )}
                    {account.status === 'unavailable' && (
                      <p>
                        La CLI non ha restituito lo stato. Verifica installazione e accesso sul
                        server, poi aggiorna.
                      </p>
                    )}
                    {account.status === 'demo' && (
                      <p>Nessun account reale consultato in modalità dimostrazione.</p>
                    )}
                  </section>
                ))}
                {data && (
                  <p className="branch-help">
                    Letto alle {new Date(data.checkedAt).toLocaleTimeString('it-IT')}
                  </p>
                )}
                <button
                  type="button"
                  className="soft-button"
                  disabled={loading}
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={16} /> Aggiorna account
                </button>
              </div>
            </div>
          </dialog>,
          document.body,
        )}
    </>
  );
}
