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
}: {
  chat: Detail;
  connected: boolean;
  onChanges(): void;
}) {
  const run = currentWork(chat.runs);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!run || (!busy(run.status) && run.status !== 'queued')) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.id, run?.status]);
  if (!run) return null;
  const activity = chat.activity.filter((a) => a.run_id === run.id).at(-1);
  return (
    <section className="work-status" aria-label="Stato del lavoro">
      <div className="work-status-heading">
        <StatusBadge status={run.status} paused={!!chat.queue_paused} />
        <small>
          {run.status === 'queued' ? 'In attesa da ' : 'Durata '}
          {duration(
            (busy(run.status) || run.status === 'queued' ? now : run.updated_at) - run.created_at,
          )}
        </small>
      </div>
      {!connected && <p>Connessione assente: lo stato verrà aggiornato alla riconnessione.</p>}
      {run.status === 'queued' ? (
        <p>
          {chat.queue_paused
            ? 'La coda è in pausa. Puoi riprenderla dal pannello Coda.'
            : 'La richiesta partirà appena si libera un agente.'}
        </p>
      ) : run.status === 'awaiting_input' ? (
        <p>Rispondi alla domanda nella chat per proseguire. Gli altri messaggi restano in pausa.</p>
      ) : run.error ? (
        <p>{run.error}</p>
      ) : activity && busy(run.status) ? (
        <p>Ultima attività: {activity.text}</p>
      ) : run.status === 'transcribing' ? (
        <p>Trascrizione del messaggio vocale in corso.</p>
      ) : run.status === 'running' ? (
        <p>L’agente sta lavorando alla richiesta.</p>
      ) : null}
      {run.status === 'complete' && (
        <p>Esecuzione terminata. Le verifiche effettuate sono descritte nella risposta.</p>
      )}
      {!!chat.queue.length && run.status !== 'queued' && (
        <small>
          {chat.queue.length} messaggi in coda{chat.queue_paused ? ' · in pausa' : ''}
        </small>
      )}
      {(chat.repo || chat.workspace) && (
        <button type="button" onClick={onChanges}>
          Apri modifiche
        </button>
      )}
    </section>
  );
}
