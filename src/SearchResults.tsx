import { useEffect, useState } from 'react';
import { api } from './api';
interface Result {
  id: string;
  conversation_id: string;
  title: string;
  role: string;
  excerpt: string;
}
interface Page {
  results: Result[];
  hasMore: boolean;
}
export function SearchResults({
  query,
  onSelect,
}: {
  query: string;
  onSelect(chatId: string, messageId: string): void;
}) {
  const [data, setData] = useState<Page>({ results: [], hasMore: false });
  const [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setOffset(0);
    setData({ results: [], hasMore: false });
  }, [query]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      void api<Page>(`/search?q=${encodeURIComponent(query.trim())}&offset=${offset}`)
        .then((value) => {
          if (!cancelled) setData(value);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, offset]);
  return (
    <section className="search-results" aria-label="Risultati nei messaggi">
      <h3>Nei messaggi</h3>
      {loading ? (
        <p role="status">Ricerca…</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          {!data.results.length && <p>Nessun messaggio trovato.</p>}
          {data.results.map((result) => (
            <button
              className="search-result"
              key={result.id}
              onClick={() => onSelect(result.conversation_id, result.id)}
            >
              <strong>{result.title}</strong>
              <small>{result.role === 'user' ? 'Tu' : 'Assistente'}</small>
              <span>…{result.excerpt}…</span>
            </button>
          ))}
          <div className="search-pages">
            {offset > 0 && <button onClick={() => setOffset(offset - 40)}>Precedenti</button>}
            {data.hasMore && (
              <button onClick={() => setOffset(offset + 40)}>Altri risultati</button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
