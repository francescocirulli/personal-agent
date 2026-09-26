import { useEffect, useState } from 'react';
import { api, type Chat } from './api';

export function ModelPicker({ chat, onSaved }: { chat: Chat; onSaved(): Promise<void> }) {
  const [catalog, setCatalog] = useState<{
    models: { id: string; name: string }[];
    source: string;
  }>({ models: [], source: '' });
  const [custom, setCustom] = useState(false),
    [value, setValue] = useState('');
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    api<typeof catalog>(`/conversations/${chat.id}/models`)
      .then((c) => {
        if (!disposed) setCatalog(c);
      })
      .catch(() => {
        if (!disposed) setError('Catalogo non disponibile. Puoi inserire un ID modello.');
      });
    return () => {
      disposed = true;
    };
  }, [chat.id]);
  async function save(model: string | null) {
    setPending(true);
    setError('');
    try {
      await api(`/conversations/${chat.id}/model`, { model });
      await onSaved();
      setCustom(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="model-picker">
      <label>
        Modello
        <select
          aria-label="Modello della chat"
          value={custom ? '__custom' : chat.model || ''}
          disabled={pending}
          onChange={(e) => {
            if (e.target.value === '__custom') {
              setCustom(true);
              setValue(chat.model || '');
            } else void save(e.target.value || null);
          }}
        >
          <option value="">Predefinito CLI / sessione</option>
          {chat.model && !catalog.models.some((m) => m.id === chat.model) && (
            <option value={chat.model}>{chat.model}</option>
          )}
          {catalog.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          <option value="__custom">Altro modello…</option>
        </select>
      </label>
      {custom && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(value.trim());
          }}
        >
          <input
            aria-label="ID modello"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={160}
            required
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="ID modello della CLI"
          />
          <button disabled={pending || !value.trim()}>Salva modello</button>
          <button type="button" onClick={() => setCustom(false)}>
            Annulla
          </button>
        </form>
      )}
      <small>Dal prossimo messaggio. {catalog.source}</small>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
