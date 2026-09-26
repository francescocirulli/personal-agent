import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
const key = (id: string) => `personal-agent:draft:${id}`;
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('personal-agent-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}
async function storedFiles(id: string, files?: File[]) {
  const database = await db();
  return new Promise<File[]>((resolve, reject) => {
    const tx = database.transaction('files', files === undefined ? 'readonly' : 'readwrite');
    const store = tx.objectStore('files');
    const request =
      files === undefined ? store.get(id) : files.length ? store.put(files, id) : store.delete(id);
    let result: File[] = [];
    request.onsuccess = () => {
      result = files ?? request.result ?? [];
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
function readText(id: string | null) {
  try {
    return id ? localStorage.getItem(key(id)) || '' : '';
  } catch {
    return '';
  }
}
export async function deleteDraft(id: string) {
  localStorage.removeItem(key(id));
  await storedFiles(id, []);
}
export function useDraft(id: string | null) {
  const [text, setText] = useState({ id, value: readText(id) });
  const [files, setFiles] = useState<{ id: string | null; value: File[]; ready: boolean }>({
    id,
    value: [],
    ready: false,
  });
  const [error, setError] = useState('');
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => {
    let cancelled = false;
    setError('');
    setText({ id, value: readText(id) });
    if (id)
      void storedFiles(id)
        .then((value) => {
          if (!cancelled) setFiles({ id, value, ready: true });
        })
        .catch(() => {
          if (!cancelled) {
            setFiles({ id, value: [], ready: true });
            setError(
              'Non posso recuperare o salvare gli allegati della bozza su questo dispositivo.',
            );
          }
        });
    return () => {
      cancelled = true;
    };
  }, [id]);
  const setDraft = (value: string) => {
    setText({ id, value });
    if (id)
      try {
        if (value) localStorage.setItem(key(id), value);
        else localStorage.removeItem(key(id));
      } catch {
        setError('Spazio insufficiente: la bozza non è stata salvata sul dispositivo.');
      }
  };
  const setImages: Dispatch<SetStateAction<File[]>> = (update) => {
    const previous = filesRef.current.id === id ? filesRef.current.value : [];
    const value = typeof update === 'function' ? update(previous) : update;
    const next = { id, value, ready: true };
    filesRef.current = next;
    setFiles(next);
    if (id)
      void storedFiles(id, value).catch(() =>
        setError(
          'Gli allegati della bozza non sono stati salvati: spazio insufficiente o archiviazione non disponibile.',
        ),
      );
  };
  return {
    draft: text.id === id ? text.value : readText(id),
    setDraft,
    images: files.id === id ? files.value : [],
    setImages,
    draftReady: files.id === id && files.ready,
    draftError: error,
  };
}
