import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, GitBranch, FolderGit2, X, Check, LoaderCircle } from 'lucide-react';
import type { GitView } from '../server/git';
import { api, type Chat } from './api';

export function BranchPicker({
  chat,
  running,
  onSaved,
}: {
  chat: Chat;
  running: boolean;
  onSaved(): Promise<void>;
}) {
  const [state, setState] = useState<GitView>();
  const [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [pending, setPending] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [search, setSearch] = useState(''),
    [name, setName] = useState(''),
    [base, setBase] = useState('HEAD');
  const [creating, setCreating] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const sequence = useRef(0),
    mounted = useRef(true);
  async function refresh() {
    if (document.hidden) return;
    const request = ++sequence.current;
    setLoading(true);
    try {
      const next = await api<GitView>(`/conversations/${chat.id}/git`);
      if (mounted.current && request === sequence.current) {
        setState(next);
        setError('');
      }
    } catch (e) {
      if (mounted.current && request === sequence.current) {
        setState(undefined);
        setError((e as Error).message);
      }
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const update = () => void refresh();
    const timer = setInterval(update, 15000);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('git-change', update);
    return () => {
      mounted.current = false;
      sequence.current++;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('git-change', update);
    };
  }, [chat.id, chat.workspace, running]);
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      void refresh();
    } else if (dialog.current?.open) dialog.current.close();
  }, [open]);
  function close() {
    dialog.current?.close();
    setOpen(false);
    setNotice('');
    trigger.current?.focus();
  }
  async function action(body: unknown, success: string) {
    setPending(true);
    setError('');
    setNotice('');
    ++sequence.current;
    try {
      const next = await api<GitView>(`/conversations/${chat.id}/git`, body);
      if (!mounted.current) return;
      ++sequence.current;
      setState(next);
      setNotice(success);
      setCreating(false);
      setName('');
      await onSaved();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) {
        setPending(false);
        setLoading(false);
      }
    }
  }
  const label =
    state?.branch ||
    (state?.detached
      ? `Commit ${state.head?.slice(0, 7)}`
      : state?.ready
        ? 'Nessun commit'
        : error
          ? 'Stato non disponibile'
          : chat.workspace
            ? 'Branch non disponibile'
            : 'Da preparare');
  const blocked = running ? 'Attendi la fine del task prima di cambiare branch.' : state?.blocked;
  const reason =
    blocked ||
    (state?.changedFiles
      ? `${state.changedFiles} file con modifiche locali. Chiedi all’agente di salvarle in un commit prima di cambiare o creare un branch.`
      : '');
  const disabled = pending || !!reason || !state?.ready;
  const branches = (state?.branches || []).filter((b) =>
    b.name.toLowerCase().includes(search.toLowerCase()),
  );
  if (!chat.repo && !state?.ready)
    return (
      <span className="repo-empty">
        <FolderGit2 size={14} /> Nessun progetto
      </span>
    );
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="repo-branch-button"
        aria-label="Repository e branch"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <FolderGit2 size={15} aria-hidden="true" />
        <span>
          <strong>{chat.repo?.split('/')[1] || 'Repository locale'}</strong>
          <small>
            <GitBranch size={12} aria-hidden="true" />
            {label}
            {!!state?.changedFiles && ' •'}
          </small>
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <dialog
            ref={dialog}
            className="branch-sheet"
            aria-labelledby="branch-title"
            onCancel={(e) => {
              e.preventDefault();
              close();
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div className="branch-sheet-content">
              <header>
                <h2 id="branch-title">Repository e branch</h2>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Chiudi branch"
                  onClick={close}
                >
                  <X size={22} />
                </button>
              </header>
              <div className="branch-sheet-scroll">
                <p className="branch-repository">{chat.repo || 'Repository locale della chat'}</p>
                {state?.ready && (
                  <p className="branch-current">
                    <GitBranch size={18} /> <strong>{label}</strong>
                  </p>
                )}
                {notice && (
                  <p className="branch-notice" role="status">
                    {notice}
                  </p>
                )}
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                {reason && (
                  <p className="branch-warning" role="status">
                    {reason}
                  </p>
                )}
                {pending && (
                  <p role="status">
                    <LoaderCircle size={16} className="spin" /> Operazione in corso…
                  </p>
                )}
                {!state?.ready ? (
                  <>
                    <p>
                      {chat.repo
                        ? 'Prepara la copia della repository per scegliere il branch prima del primo messaggio.'
                        : 'Questa cartella non contiene una repository Git.'}
                    </p>
                    {chat.repo && !chat.workspace && (
                      <button
                        type="button"
                        className="branch-primary"
                        disabled={pending || !!blocked || running}
                        onClick={() => void action({ action: 'prepare' }, 'Repository pronta.')}
                      >
                        Prepara repository
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={loading || pending}
                      onClick={() => void refresh()}
                    >
                      Riprova lettura stato
                    </button>
                  </>
                ) : (
                  <>
                    <div className="branch-toolbar">
                      <button
                        type="button"
                        disabled={pending || !!blocked}
                        onClick={() =>
                          void action(
                            { action: 'fetch' },
                            'Elenco remoto aggiornato. I file locali non sono cambiati.',
                          )
                        }
                      >
                        Aggiorna da GitHub
                      </button>
                      <button
                        type="button"
                        disabled={disabled || !state.head}
                        onClick={() => {
                          setCreating(!creating);
                          setBase('HEAD');
                        }}
                      >
                        Nuovo branch
                      </button>
                    </div>
                    {creating && (
                      <form
                        className="branch-create"
                        onSubmit={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void action(
                            { action: 'create', name: name.trim(), base },
                            `Branch ${name.trim()} creato e selezionato.`,
                          );
                        }}
                      >
                        <label>
                          Nome del nuovo branch
                          <input
                            aria-label="Nome del nuovo branch"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            maxLength={160}
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            placeholder="feature/notifiche"
                            required
                          />
                        </label>
                        <label>
                          Parti da
                          <select
                            aria-label="Branch di partenza"
                            value={base}
                            onChange={(e) => setBase(e.target.value)}
                          >
                            <option value="HEAD">Posizione corrente ({label})</option>
                            {state.branches.map((b) => (
                              <option key={b.ref} value={b.ref}>
                                {b.name}
                                {b.remote ? ' · remoto' : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button className="branch-primary" disabled={disabled || !name.trim()}>
                          Crea e passa al branch
                        </button>
                      </form>
                    )}
                    <label className="branch-search">
                      Cerca un branch
                      <input
                        type="search"
                        aria-label="Cerca un branch"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        autoCapitalize="none"
                        autoCorrect="off"
                        placeholder="Nome del branch"
                      />
                    </label>
                    {[false, true].map((remote) => (
                      <section
                        key={String(remote)}
                        aria-label={remote ? 'Branch remoti' : 'Branch locali'}
                      >
                        <h3>{remote ? 'Su GitHub / remoti' : 'Locali'}</h3>
                        {branches
                          .filter((b) => b.remote === remote)
                          .map((branch) => {
                            const selected = !remote && branch.name === state.branch;
                            return (
                              <button
                                type="button"
                                className="branch-option"
                                key={branch.ref}
                                disabled={disabled || selected}
                                aria-current={selected ? 'true' : undefined}
                                onClick={() =>
                                  void action(
                                    { action: 'switch', branch: branch.ref },
                                    `Branch ${branch.name} selezionato.`,
                                  )
                                }
                              >
                                <GitBranch size={17} />
                                <span>{branch.name}</span>
                                {selected && <Check size={18} />}
                              </button>
                            );
                          })}
                      </section>
                    ))}
                    {!branches.length && <p>Nessun branch trovato.</p>}
                    <p className="branch-help">
                      Il cambio vale per questa chat. Aggiorna recupera l’elenco remoto; creare o
                      cambiare branch non esegue un push.
                    </p>
                  </>
                )}
              </div>
            </div>
          </dialog>,
          document.body,
        )}
    </>
  );
}
