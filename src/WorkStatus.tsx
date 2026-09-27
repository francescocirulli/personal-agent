import { useEffect, useState } from 'react';
import {
  CircleCheck,
  CircleX,
  CircleHelp,
  Clock,
  LoaderCircle,
  Square,
  TriangleAlert,
} from 'lucide-react';
import type { Run, RunStatus } from '../server/store';
import type { Detail } from './api';
import { busy } from './api';
import { ActivityPanel } from './ActivityPanel';
import { ChatMarkdown } from './ChatMarkdown';
import { useWorkChanges, type DiffMode } from './useWorkChanges';
export const statusLabels: Record<RunStatus, string> = {
  queued: 'In coda',
  transcribing: 'Trascrizione',
  running: 'In corso',
  awaiting_input: 'Serve una risposta',
  complete: 'Completato',
  error: 'Errore',
  cancelled: 'Fermato',
  interrupted: 'Interrotto',
};
const icons = {
  queued: Clock,
  transcribing: LoaderCircle,
  running: LoaderCircle,
  awaiting_input: CircleHelp,
  complete: CircleCheck,
  error: CircleX,
  cancelled: Square,
  interrupted: TriangleAlert,
};
export function StatusBadge({
  status,
  paused = false,
  id,
}: {
  status?: RunStatus | null;
  paused?: boolean;
  id?: string;
}) {
  if (!status) return null;
  const Icon = icons[status];
  return (
    <span id={id} className={`work-badge work-${status}`}>
      <Icon size={14} aria-hidden="true" className={busy(status) ? 'spin' : ''} />
      {status === 'queued' && paused ? 'Coda in pausa' : statusLabels[status]}
    </span>
  );
}
export function currentWork(runs: Run[]) {
  const latest = runs.filter((r) => r.status !== 'queued').at(-1);
  return (
    runs.find((r) => busy(r.status)) ||
    (latest?.status === 'awaiting_input' ? latest : undefined) ||
    runs.find((r) => r.status === 'queued') ||
    latest
  );
}
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds} s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} min ${seconds % 60} s`
      : `${Math.floor(seconds / 3600)} h ${Math.floor(seconds / 60) % 60} min`;
}
export function WorkStatus({
  chat,
  connected,
  onChanges,
  sending,
  preview,
  activityOpen,
  onActivityOpenChange,
  onStop,
}: {
  chat: Detail;
  connected: boolean;
  onChanges(mode: DiffMode): void;
  sending: boolean;
  preview: string;
  activityOpen: boolean;
  onActivityOpenChange(open: boolean): void;
  onStop(): void;
}) {
  const run = currentWork(chat.runs);
  const working = sending || busy(run?.status);
  const changes = useWorkChanges(chat);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!run || (!busy(run.status) && run.status !== 'queued')) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.id, run?.status]);
  if (!run && !sending && !chat.activity.length && !changes) return null;
  const activity = chat.activity.filter((a) => a.run_id === run?.id).at(-1);
  return (
    <section className="work-status" aria-label="Stato del lavoro">
      {(run || working) && (
        <div className="work-status-heading">
          <StatusBadge status={run?.status || 'running'} paused={!!chat.queue_paused} />
          {run && (
            <small>
              {run.status === 'queued' ? 'In attesa da ' : 'Durata '}
              {duration(
                (busy(run.status) || run.status === 'queued' ? now : run.updated_at) -
                  run.created_at,
              )}
            </small>
          )}
          {working && (
            <button type="button" className="work-stop" onClick={onStop} aria-label="Ferma task">
              <Square size={12} /> Ferma
            </button>
          )}
        </div>
      )}
      {!connected && <p>Connessione assente: lo stato verrà aggiornato alla riconnessione.</p>}
      {sending ? (
        <p>Invio il messaggio…</p>
      ) : run?.status === 'queued' ? (
        <p>
          {chat.queue_paused
            ? 'La coda è in pausa. Puoi riprenderla dal pannello Coda.'
            : 'La richiesta partirà appena si libera un agente.'}
        </p>
      ) : run?.status === 'awaiting_input' ? (
        <p>Rispondi alla domanda nella chat per proseguire. Gli altri messaggi restano in pausa.</p>
      ) : run?.error ? (
        <p>{run.error}</p>
      ) : !preview && activity && busy(run?.status) ? (
        <p className="work-latest" title={activity.text}>
          Ultima attività: {activity.text}
        </p>
      ) : run?.status === 'transcribing' ? (
        <p>Trascrizione del messaggio vocale in corso.</p>
      ) : !preview && run?.status === 'running' ? (
        <p>L’agente sta lavorando alla richiesta.</p>
      ) : null}
      {working && preview && (
        <div className="preview">
          <ChatMarkdown text={preview} />
        </div>
      )}
      <div className="work-tools">
        {changes && (
          <div className="work-changes">
            <button
              type="button"
              aria-label={`Apri modifiche (${changes.total})`}
              title={
                changes.mode === 'local'
                  ? 'Modifiche locali'
                  : `Confronto con ${changes.base?.replace(/^refs\/(heads|remotes)\//, '') || 'il branch di base'}`
              }
              onClick={() => onChanges(changes.mode)}
            >
              Modifiche · {changes.total}
            </button>
          </div>
        )}
        {!!chat.activity.length && (
          <ActivityPanel
            compact
            activity={chat.activity}
            open={activityOpen}
            onOpenChange={onActivityOpenChange}
          />
        )}
      </div>
    </section>
  );
}
