import { useEffect, useState } from 'react';
import { api, type Chat } from './api';
import type { AgentCatalog } from '../server/agent-models';
import {
  pairKey,
  type ExperimentView,
  type RoutingConfig,
  type ModelEffort,
} from '../server/experiments';

export function ChatExperimentsPicker({
  agent,
  value,
  onChange,
  disabled = false,
  manual,
}: {
  agent: 'codex' | 'claude';
  value: RoutingConfig | null;
  onChange(value: RoutingConfig | null): void;
  disabled?: boolean;
  manual?: ModelEffort;
}) {
  const [view, setView] = useState<ExperimentView>();
  const [catalog, setCatalog] = useState<AgentCatalog>();
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false,
      sequence = 0;
    async function refresh() {
      const request = ++sequence;
      try {
        const [flags, models] = await Promise.all([
          api<ExperimentView>('/settings/experiments'),
          api<AgentCatalog>(`/agents/${agent}/models`),
        ]);
        if (!disposed && request === sequence) {
          setView(flags);
          setCatalog(models);
          setError('');
        }
      } catch (e) {
        if (!disposed && request === sequence) {
          setError((e as Error).message);
          setCatalog(undefined);
        }
      }
    }
    setCatalog(undefined);
    void refresh();
    window.addEventListener('experiments-change', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      window.removeEventListener('experiments-change', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [agent]);
  const models = (catalog?.models || []).filter(
    (model) => /^gpt-/.test(model.id) && model.efforts.length && model.modalities.includes('text'),
  );
  const pairs = models.flatMap((model) =>
    model.efforts.map((effort) => ({ model: model.id, effort })),
  );
  const available =
    agent === 'codex' &&
    view?.enabled &&
    view.smartRouting &&
    (view.configured || view.demo) &&
    pairs.length > 0 &&
    !error;
  function defaults(): RoutingConfig {
    const fallback =
      pairs.find((pair) => manual && pairKey(pair) === pairKey(manual)) ||
      pairs.find((pair) => pair.effort === 'high') ||
      pairs[0];
    return {
      enabled: true,
      preference: 'balanced',
      fallback,
      candidates: pairs.filter((pair) => !['max', 'ultra'].includes(pair.effort)).slice(0, 254),
    };
  }
  const fallbackPresent = value && pairs.some((pair) => pairKey(pair) === pairKey(value.fallback));
  return (
    <details className="chat-experiments-picker">
      <summary>Funzionalità sperimentali{value?.enabled ? ' · JEV selezionato' : ''}</summary>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {agent === 'claude' ? (
        <p className="settings-note">
          Routing JEV disponibile per Codex. Claude Code arriverà in seguito.
        </p>
      ) : (
        <>
          {!view && !error && <p>Caricamento…</p>}
          {view && !view.enabled && (
            <p className="settings-note">
              Abilita le funzionalità sperimentali in Impostazioni → Sperimentali.
            </p>
          )}
          {view?.enabled && !view.smartRouting && (
            <p className="settings-note">Abilita JEV in Impostazioni → Sperimentali.</p>
          )}
          {view?.enabled && view.smartRouting && !view.configured && !view.demo && (
            <p className="settings-note">Chiave OpenRouter non configurata sul server.</p>
          )}
          {catalog && models.length === 0 && (
            <p className="settings-note">
              Catalogo Codex non disponibile o senza effort compatibili. Avvia la CLI Codex sul
              server per aggiornarlo.
            </p>
          )}
          {(view?.smartRouting || value) && (
            <label className="tool-choice">
              <input
                type="checkbox"
                checked={!!value?.enabled}
                disabled={disabled || (!value?.enabled && !available)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? value
                        ? { ...value, enabled: true }
                        : defaults()
                      : value
                        ? { ...value, enabled: false }
                        : null,
                  )
                }
              />
              Routing intelligente · JEV
            </label>
          )}
          {value?.enabled && (
            <fieldset disabled={disabled || !available} className="routing-options">
              <p className="settings-note">
                La tua subscription esegue il lavoro. JEV riceve testo recente per la scelta e usa
                un piccolo costo OpenRouter separato.
              </p>
              <label>
                Preferenza
                <select
                  aria-label="Preferenza routing"
                  value={value.preference}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      preference: e.target.value as RoutingConfig['preference'],
                    })
                  }
                >
                  <option value="balanced">Equilibrio</option>
                  <option value="speed">Velocità</option>
                  <option value="quality">Qualità</option>
                </select>
              </label>
              <label>
                Modello di riserva
                <select
                  aria-label="Modello ed effort di riserva"
                  value={pairKey(value.fallback)}
                  onChange={(e) => {
                    const fallback = pairs.find((pair) => pairKey(pair) === e.target.value);
                    if (fallback) onChange({ ...value, fallback });
                  }}
                >
                  {!fallbackPresent && (
                    <option value={pairKey(value.fallback)}>
                      {value.fallback.model} · {value.fallback.effort} (non disponibile)
                    </option>
                  )}
                  {pairs.map((pair) => (
                    <option key={pairKey(pair)} value={pairKey(pair)}>
                      {models.find((model) => model.id === pair.model)?.name} · {pair.effort}
                    </option>
                  ))}
                </select>
              </label>
              <p>Modelli ed effort consentiti</p>
              <button type="button" className="quiet" onClick={() => onChange(defaults())}>
                Ripristina dal catalogo
              </button>
              {models.map((model) => (
                <div className="routing-model" key={model.id}>
                  <strong>{model.name}</strong>
                  <small>{model.description}</small>
                  <div className="routing-efforts">
                    {model.efforts.map((effort) => {
                      const pair = { model: model.id, effort };
                      const checked = value.candidates.some(
                        (candidate) => pairKey(candidate) === pairKey(pair),
                      );
                      return (
                        <label key={effort}>
                          <input
                            type="checkbox"
                            aria-label={`${model.name} ${effort}`}
                            checked={checked}
                            disabled={
                              (checked && value.candidates.length === 1) ||
                              (!checked && value.candidates.length >= 254)
                            }
                            onChange={(e) =>
                              onChange({
                                ...value,
                                candidates: e.target.checked
                                  ? [...value.candidates, pair]
                                  : value.candidates.filter(
                                      (candidate) => pairKey(candidate) !== pairKey(pair),
                                    ),
                              })
                            }
                          />
                          {effort}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
              {value.candidates.some(
                (pair) => !pairs.some((allowed) => pairKey(allowed) === pairKey(pair)),
              ) && (
                <p role="alert">
                  Il catalogo è cambiato. Ripristina dal catalogo prima di salvare.
                </p>
              )}
              <small>
                {catalog?.source}
                {catalog?.fetchedAt &&
                  ` Aggiornato: ${new Date(catalog.fetchedAt).toLocaleString('it-IT')}`}
              </small>
            </fieldset>
          )}
        </>
      )}
    </details>
  );
}

export function ChatExperiments({ chat, onSaved }: { chat: Chat; onSaved(): Promise<void> }) {
  const [value, setValue] = useState(chat.routing || null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const saved = JSON.stringify(chat.routing || null);
  useEffect(() => {
    setValue(JSON.parse(saved));
    setError('');
  }, [chat.id, saved]);
  async function save() {
    setPending(true);
    setError('');
    try {
      await api(`/conversations/${chat.id}/routing`, { routing: value });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="chat-experiments">
      <ChatExperimentsPicker
        agent={chat.agent}
        value={value}
        onChange={setValue}
        disabled={pending}
        manual={chat.model ? { model: chat.model, effort: chat.effort } : undefined}
      />
      {JSON.stringify(value) !== saved && (
        <button className="soft-button" disabled={pending} onClick={() => void save()}>
          Salva esperimenti chat
        </button>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
