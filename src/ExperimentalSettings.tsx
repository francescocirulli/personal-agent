import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from './api';
import type { ExperimentView } from '../server/experiments';
import { SettingsTabs, type SettingsTab } from './SettingsTabs';

export function ExperimentalSettings({
  onClose,
  onTab,
}: {
  onClose(): void;
  onTab(tab: SettingsTab): void;
}) {
  const [view, setView] = useState<ExperimentView>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let disposed = false;
    api<ExperimentView>('/settings/experiments')
      .then((value) => {
        if (!disposed) setView(value);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, []);
  async function save(change: Partial<ExperimentView>) {
    if (!view || pending) return;
    const previous = view;
    setView({ ...view, ...change });
    setPending(true);
    setError('');
    try {
      setView(
        await api('/settings/experiments', {
          enabled: view.enabled,
          smartRouting: view.smartRouting,
          ...change,
        }),
      );
      window.dispatchEvent(new Event('experiments-change'));
    } catch (e) {
      setView(previous);
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="experiments-heading"
      >
        <button
          className="modal-close icon-button"
          aria-label="Chiudi funzionalità sperimentali"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <h2 id="experiments-heading">Funzionalità sperimentali</h2>
        <SettingsTabs current="experiments" onTab={onTab} disabled={pending} />
        <p>
          Prova nuove funzioni scegliendo in quali chat usarle. Le disattivazioni globali hanno
          sempre precedenza.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {!view ? (
          <p>Caricamento…</p>
        ) : (
          <>
            <label className="tool-choice">
              <input
                type="checkbox"
                checked={view.enabled}
                disabled={pending}
                onChange={(e) => void save({ enabled: e.target.checked })}
              />
              Abilita funzionalità sperimentali
            </label>
            <article className="skill-card">
              <label className="tool-choice">
                <input
                  type="checkbox"
                  checked={view.smartRouting}
                  disabled={pending || !view.enabled}
                  onChange={(e) => void save({ smartRouting: e.target.checked })}
                />
                <strong>Routing intelligente · JEV</strong>
              </label>
              <p>
                Solo Codex. Sceglie modello OpenAI ed effort prima di ogni messaggio, mantenendo la
                tua subscription Codex.
              </p>
              <p className="settings-note">
                JEV riceve parte del testo recente della chat tramite OpenRouter e ha un piccolo
                costo API separato. L’esecuzione resta nella CLI Codex. Nessun passaggio automatico
                ad API a pagamento per il lavoro dell’agente.
              </p>
              <p role="status">
                {view.demo
                  ? 'Dimostrazione: nessuna chiamata a pagamento.'
                  : view.configured
                    ? 'Chiave OpenRouter configurata sul server.'
                    : 'Configura OPENROUTER_API_KEY sul server per usare JEV.'}
              </p>
              <p className="settings-note">
                Attiva poi JEV nelle singole chat. Spegnendo queste opzioni, i prossimi turni usano
                il modello di riserva; i turni già avviati proseguono. Riaccendendole si
                ripristinano le chat già abilitate.
              </p>
            </article>
          </>
        )}
      </section>
    </div>
  );
}
