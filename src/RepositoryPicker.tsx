import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  FolderGit2,
  Github,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  Search,
  Zap,
} from 'lucide-react';
import { api, type GitHubInfo, type WorkspaceMode } from './api';

export function RepositoryPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (repo: string, required: boolean) => void;
}) {
  const [mode, setMode] = useState(value ? 'repository' : 'free');
  const [owner, setOwner] = useState(value.split('/')[0] || '');
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState(false);
  const [github, setGithub] = useState<GitHubInfo>();
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (mode !== 'repository') return;
    let cancelled = false;
    setLoading(true);
    api<GitHubInfo>('/github')
      .then((data) => {
        if (!cancelled) setGithub(data);
      })
      .catch(() => {
        if (!cancelled)
          setGithub({
            connected: false,
            login: null,
            owners: [],
            repositories: [],
            error: 'Non riesco a caricare GitHub. Riprova tra poco.',
          });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, attempt]);
  const needle = query.trim().toLowerCase();
  const matches = (github?.repositories || [])
    .filter((repo) => repo.fullName.split('/')[0].toLowerCase() === owner.toLowerCase())
    .filter((repo) => repo.fullName.split('/')[1].toLowerCase().includes(needle))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  return (
    <div className="repository-picker">
      <label>Progetto</label>
      <div className="project-mode" role="group" aria-label="Tipo di conversazione">
        <button
          type="button"
          aria-pressed={mode === 'free'}
          onClick={() => {
            setMode('free');
            setOwner('');
            setQuery('');
            setManual(false);
            onChange('', false);
          }}
        >
          <MessageCircle size={16} /> Chat libera
        </button>
        <button
          type="button"
          aria-pressed={mode === 'repository'}
          onClick={() => {
            if (mode !== 'repository') {
              setMode('repository');
              onChange('', true);
            }
          }}
        >
          <Github size={16} /> Repository GitHub
        </button>
      </div>
      {mode === 'free' ? (
        <small>Una conversazione senza repository.</small>
      ) : (
        <>
          {loading ? (
            <p className="picker-status" role="status">
              <LoaderCircle size={16} className="spin" /> Carico account e repository…
            </p>
          ) : github?.connected ? (
            <p className="picker-status">
              <Github size={14} /> Collegato a {github.login}
            </p>
          ) : (
            <div className="picker-status" role="status">
              <span>{github?.error || 'GitHub non disponibile.'}</span>
              <button type="button" className="quiet" onClick={() => setAttempt((n) => n + 1)}>
                Riprova
              </button>
            </div>
          )}
          {!manual && (
            <>
              <label htmlFor="github-owner">1. Account o organizzazione</label>
              <select
                id="github-owner"
                className="settings-input"
                value={owner}
                disabled={loading || !github?.connected}
                onChange={(e) => {
                  setOwner(e.target.value);
                  setQuery('');
                  onChange('', true);
                }}
              >
                <option value="">Scegli un account…</option>
                {github?.owners.map((account) => (
                  <option value={account.login} key={account.login}>
                    {account.login}
                    {account.login === github.login
                      ? ' · Personale'
                      : account.type === 'Organization'
                        ? ' · Organizzazione'
                        : ''}
                  </option>
                ))}
              </select>
              {owner && (
                <>
                  <label htmlFor="repository-search">2. Repository</label>
                  {value ? (
                    <div className="selected-repository">
                      <Check size={18} />
                      <span>
                        <strong>{value.split('/')[1]}</strong>
                        <small>{value.split('/')[0]}</small>
                      </span>
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => {
                          onChange('', true);
                          setQuery('');
                        }}
                      >
                        Cambia
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="repository-search">
                        <Search size={17} />
                        <input
                          id="repository-search"
                          type="search"
                          aria-label="Cerca repository"
                          placeholder="Scrivi le prime lettere…"
                          autoComplete="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.preventDefault();
                          }}
                        />
                      </div>
                      <small className="repository-count" role="status">
                        {matches.length
                          ? `${matches.length} repository · tocca per scegliere`
                          : query
                            ? 'Nessun repository corrisponde alla ricerca.'
                            : 'Nessun repository accessibile per questo account.'}
                      </small>
                      {!!matches.length && (
                        <ul className="repository-options" aria-label="Repository disponibili">
                          {matches.map((repo) => (
                            <li key={repo.fullName}>
                              <button
                                type="button"
                                onClick={() => {
                                  onChange(repo.fullName, true);
                                }}
                              >
                                <FolderGit2 size={17} />
                                <span>{repo.fullName.split('/')[1]}</span>
                                {repo.private && <LockKeyhole size={14} aria-label="Privato" />}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
          <button
            type="button"
            className="quiet manual-repository-toggle"
            onClick={() => {
              setManual(!manual);
              setOwner('');
              setQuery('');
              onChange('', true);
            }}
          >
            {manual ? 'Torna alla selezione guidata' : 'Inserisci un repository manualmente'}
          </button>
          {manual && (
            <>
              <label htmlFor="manual-repository">Percorso repository</label>
              <input
                id="manual-repository"
                className="settings-input"
                placeholder="organizzazione/repository"
                value={value}
                onChange={(e) => onChange(e.target.value, true)}
                pattern="[\w.\-]+/[\w.\-]+"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

export function WorkspaceModePicker({
  value,
  onChange,
}: {
  value: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
}) {
  return (
    <div className="repository-picker">
      <label>Cartella di lavoro</label>
      <div className="project-mode" role="group" aria-label="Cartella di lavoro">
        <button type="button" aria-pressed={value === 'shared'} onClick={() => onChange('shared')}>
          <Zap size={16} /> Condivisa
        </button>
        <button
          type="button"
          aria-pressed={value === 'isolated'}
          onClick={() => onChange('isolated')}
        >
          <Copy size={16} /> Isolata
        </button>
      </div>
      <small>
        {value === 'shared'
          ? 'Riusa una copia del repository: branch e modifiche sono condivisi tra le chat, anche mentre lavorano insieme.'
          : 'Una copia e un branch dedicati a questa chat: più lenta da preparare, nessuna interferenza.'}
      </small>
    </div>
  );
}
