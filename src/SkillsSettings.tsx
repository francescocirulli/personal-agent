import type { MarkdownDocument } from './markdown';
import { useEffect, useState } from 'react';
import { X, Plus, Trash2, Pencil, FileText } from 'lucide-react';
import { api, type Chat } from './api';
import type { SkillView, SkillAgent } from '../server/skills';

const template = `---
name: mia-skill
description: Descrivi quando l’agente deve usare questa skill.
---

Scrivi qui le istruzioni da seguire.
`;
type ProjectSkills = { skills: SkillView[]; warnings: string[]; ready: boolean };
export function SkillsSettings({
  chats,
  selected,
  onClose,
  onTab,
  onRead,
}: {
  chats: Chat[];
  selected: string | null;
  onClose(): void;
  onRead(document: MarkdownDocument): void;
  onTab(tab: 'voice' | 'mcp' | 'terminal'): void;
}) {
  const [globals, setGlobals] = useState<SkillView[]>([]);
  const [projectId, setProjectId] = useState(
    chats.find((c) => c.id === selected && c.repo)?.id || '',
  );
  const [project, setProject] = useState<ProjectSkills>();
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [editor, setEditor] = useState<{ id?: string; content: string; agents: SkillAgent[] }>();
  const [remove, setRemove] = useState<SkillView>();
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const result = await api<SkillView[]>('/skills');
        if (!disposed) {
          setGlobals(result);
          setLoaded(true);
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    };
    void refresh();
    window.addEventListener('skills-change', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      window.removeEventListener('skills-change', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    setProject(undefined);
    if (projectId)
      api<ProjectSkills>(`/conversations/${projectId}/skills`)
        .then((p) => {
          if (!disposed) setProject(p);
        })
        .catch((e) => {
          if (!disposed) setError(e.message);
        });
    return () => {
      disposed = true;
    };
  }, [projectId]);
  async function act(fn: () => Promise<void>) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function save() {
    if (!editor) return;
    await act(async () => {
      await api(`/skills${editor.id ? '/' + editor.id : ''}`, {
        content: editor.content,
        agents: editor.agents,
      });
      setGlobals(await api('/skills'));
      setEditor(undefined);
      setNotice(
        'Skill salvata. La scelta degli agenti si applica dal prossimo messaggio; i task in corso mantengono la versione precedente.',
      );
    });
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal skills-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skills-heading"
      >
        <button
          className="modal-close icon-button"
          aria-label="Chiudi skill"
          disabled={pending}
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <h2 id="skills-heading">Skill</h2>
        <nav className="settings-tabs" aria-label="Sezioni impostazioni">
          <button disabled={pending} onClick={() => onTab('voice')}>
            Voce
          </button>
          <button disabled={pending} onClick={() => onTab('mcp')}>
            MCP
          </button>
          <button aria-current="page">Skill</button>
          <button onClick={() => onTab('terminal')}>Terminale</button>
        </nav>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="settings-note">
            {notice}
          </p>
        )}
        {editor ? (
          <form
            className="skill-editor"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <h3>{editor.id ? 'Modifica skill globale' : 'Nuova skill globale'}</h3>
            <label>
              Importa SKILL.md
              <input
                type="file"
                accept=".md,text/markdown,text/plain"
                disabled={pending}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 65536) {
                    setError('Il file può contenere al massimo 64 KB.');
                    return;
                  }
                  void act(async () => {
                    const content = await file.text();
                    setEditor((old) => old && { ...old, content });
                  });
                }}
              />
            </label>
            <label>
              Contenuto SKILL.md
              <textarea
                rows={12}
                maxLength={65536}
                required
                disabled={pending}
                value={editor.content}
                onChange={(e) => setEditor({ ...editor, content: e.target.value })}
              />
            </label>
            <fieldset disabled={pending}>
              <legend>Disponibile per</legend>
              {(['claude', 'codex'] as const).map((agent) => (
                <label className="skill-agent-choice" key={agent}>
                  <input
                    type="checkbox"
                    checked={editor.agents.includes(agent)}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        agents: e.target.checked
                          ? [...editor.agents, agent]
                          : editor.agents.filter((a) => a !== agent),
                      })
                    }
                  />
                  {agent === 'claude' ? 'Claude Code' : 'Codex'}
                </label>
              ))}
            </fieldset>
            <p className="settings-note">
              Seleziona uno o entrambi gli agenti. Questa versione importa skill composte dal solo
              SKILL.md. Le skill con script e allegati possono essere inserite nella repository.
            </p>
            <div className="skill-actions">
              <button className="primary" disabled={pending || !editor.agents.length}>
                Salva skill
              </button>
              <button
                type="button"
                className="soft-button"
                disabled={pending}
                onClick={() => setEditor(undefined)}
              >
                Annulla
              </button>
            </div>
          </form>
        ) : (
          <>
            <h3>Globali</h3>
            <p>Valgono per tutte le chat degli agenti che scegli, anche senza repository.</p>
            <button
              className="soft-button"
              disabled={pending}
              onClick={() => {
                setEditor({ content: template, agents: [] });
                setError('');
                setNotice('');
              }}
            >
              <Plus size={16} /> Aggiungi skill
            </button>
            {!loaded && <p>Carico le skill…</p>}
            {loaded && !globals.length && (
              <p className="settings-note">Nessuna skill globale aggiunta dall’app.</p>
            )}
            <div className="skill-list">
              {globals.map((s) => (
                <article className="skill-card" key={s.id}>
                  <strong>{s.name}</strong>
                  <p>{s.description}</p>
                  <small>
                    {s.agents.map((a) => (a === 'claude' ? 'Claude Code' : 'Codex')).join(' · ')}
                  </small>
                  <div className="skill-actions">
                    <button
                      className="soft-button"
                      disabled={pending}
                      onClick={() =>
                        void act(async () => {
                          const full = await api<{ content: string }>(`/skills/${s.id}`);
                          onRead({
                            key: `skill:global:${s.id}`,
                            name: `${s.name}.md`,
                            content: full.content,
                          });
                        })
                      }
                    >
                      <FileText size={15} /> Leggi {s.name}
                    </button>
                    <button
                      className="soft-button"
                      aria-label={`Modifica ${s.name}`}
                      disabled={pending}
                      onClick={() =>
                        void act(async () => {
                          const full = await api<SkillView & { content: string }>(
                            `/skills/${s.id}`,
                          );
                          setEditor({ id: full.id, content: full.content, agents: full.agents });
                        })
                      }
                    >
                      <Pencil size={15} /> Modifica
                    </button>
                    <button
                      className="text-button"
                      aria-label={`Elimina ${s.name}`}
                      disabled={pending}
                      onClick={() => setRemove(s)}
                    >
                      <Trash2 size={15} /> Elimina
                    </button>
                  </div>
                  {remove?.id === s.id && (
                    <div className="skill-confirm">
                      <p>
                        Eliminare {s.name} dalle skill globali? Dal prossimo messaggio non sarà più
                        disponibile agli agenti assegnati.
                      </p>
                      <button
                        className="soft-button"
                        disabled={pending}
                        onClick={() =>
                          void act(async () => {
                            await api(`/skills/${s.id}/delete`, {});
                            setGlobals(await api('/skills'));
                            setRemove(undefined);
                            setNotice('Skill eliminata.');
                          })
                        }
                      >
                        Conferma eliminazione
                      </button>
                      <button
                        className="text-button"
                        disabled={pending}
                        onClick={() => setRemove(undefined)}
                      >
                        Annulla
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
            <h3>Del progetto</h3>
            <p>
              Sempre disponibili a entrambi gli agenti. Queste skill si modificano nella repository.
            </p>
            <label>
              Copia del progetto
              <select
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setError('');
                }}
              >
                <option value="">Seleziona una chat con repository</option>
                {chats
                  .filter((c) => c.repo)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.repo} · {c.title}
                    </option>
                  ))}
              </select>
            </label>
            <p className="settings-note">
              Ogni chat ha una copia indipendente della repo. L’elenco riflette i file di quella
              copia.
            </p>
            {projectId && !project && <p>Carico le skill del progetto…</p>}
            {project && !project.ready && (
              <p>
                Le skill saranno visibili dopo il primo task, quando la repository è stata
                preparata.
              </p>
            )}
            {project?.ready && !project.skills.length && (
              <p>
                Nessuna skill trovata nelle cartelle .agents/skills, .claude/skills o .codex/skills.
              </p>
            )}
            {project?.warnings.map((w) => (
              <p className="settings-note" key={w}>
                {w}
              </p>
            ))}
            <div className="skill-list">
              {project?.skills.map((s) => (
                <article className="skill-card" key={s.id}>
                  <strong>{s.name}</strong>
                  <p>{s.description}</p>
                  <small>Claude Code · Codex</small>
                  <code>{s.path}</code>
                  <button
                    className="soft-button"
                    disabled={pending}
                    onClick={() =>
                      void act(async () => {
                        const full = await api<{ content: string }>(
                          `/conversations/${projectId}/skills/file?path=${encodeURIComponent(s.id)}`,
                        );
                        onRead({
                          key: `skill:project:${projectId}:${s.id}`,
                          name: `${s.name}.md`,
                          content: full.content,
                        });
                      })
                    }
                  >
                    <FileText size={15} /> Leggi {s.name}
                  </button>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
