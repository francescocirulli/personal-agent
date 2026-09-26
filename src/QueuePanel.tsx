import { useEffect, useState } from 'react';
import { api, type Detail } from './api';
export function QueuePanel({
  chat,
  refresh,
  sendNow,
  sendingNow,
  onError,
}: {
  chat: Detail;
  refresh(): Promise<void>;
  sendNow(id: string): Promise<void>;
  sendingNow: string | null;
  onError(message: string): void;
}) {
  const [editing, setEditing] = useState<string | null>(null),
    [text, setText] = useState(''),
    [pending, setPending] = useState(false);
  useEffect(() => {
    setEditing(null);
  }, [chat.id]);
  async function action(route: string, body: unknown) {
    setPending(true);
    try {
      await api(`/conversations/${chat.id}/queue/${route}`, body);
      setEditing(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      await refresh().catch((e) => onError(e.message));
      setPending(false);
    }
  }
  function move(index: number, delta: number) {
    const ids = chat.queue.map((m) => m.run_id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    void action('reorder', { runIds: ids });
  }
  if (!chat.queue.length && !chat.queue_paused) return null;
  return (
    <section className="message-queue" aria-label="Messaggi in coda">
      <div className="queue-heading">
        <p>
          In coda · {chat.queue.length}
          {chat.queue_paused ? ' · In pausa' : ''}
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => void action('pause', { paused: !chat.queue_paused })}
        >
          {chat.queue_paused ? 'Riprendi coda' : 'Metti in pausa'}
        </button>
      </div>
      <ol>
        {chat.queue.map((message, index) => (
          <li key={message.run_id}>
            {editing === message.run_id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(`${message.run_id}/edit`, { text });
                }}
              >
                <textarea
                  aria-label="Modifica messaggio in coda"
                  maxLength={40000}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <button disabled={pending || (!text.trim() && !message.attachments?.length)}>
                  Salva
                </button>
                <button type="button" onClick={() => setEditing(null)}>
                  Annulla
                </button>
              </form>
            ) : (
              <div>
                <span>{message.text}</span>
                {!!message.attachments?.length && (
                  <small>{message.attachments.map((f) => f.name).join(', ')}</small>
                )}
              </div>
            )}
            <div className="queue-actions">
              <button
                type="button"
                disabled={pending || !!sendingNow}
                onClick={() => void sendNow(message.run_id)}
              >
                Invia subito
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setEditing(message.run_id);
                  setText(message.text);
                }}
              >
                Modifica
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => void action(`${message.run_id}/delete`, {})}
              >
                Elimina
              </button>
              <button
                type="button"
                aria-label="Sposta prima"
                disabled={pending || index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label="Sposta dopo"
                disabled={pending || index === chat.queue.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
            </div>
          </li>
        ))}
      </ol>
      <small>
        {chat.queue_paused
          ? 'I messaggi restano in attesa. Invia subito fa partire solo il messaggio scelto.'
          : 'Partono in ordine al termine del task. Invia subito interrompe quello attivo.'}
      </small>
    </section>
  );
}
