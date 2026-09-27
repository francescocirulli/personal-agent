import { isMarkdown, type MarkdownDocument } from './markdown';
import { useState } from 'react';
import type { Attachment } from '../server/store';
export function FileCards({
  chatId,
  files,
  onRead,
}: {
  chatId: string;
  files: Attachment[];
  onRead(document: MarkdownDocument): void;
}) {
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<{ id: string; file: File } | null>(null);
  async function share(file: Attachment) {
    setError('');
    setSharing(file.id);
    try {
      if (prepared?.id === file.id) {
        await navigator.share({ files: [prepared.file], title: file.name });
        setPrepared(null);
        return;
      }
      const response = await fetch(`/api/conversations/${chatId}/files/${file.id}`);
      if (!response.ok) throw new Error('Impossibile scaricare il file.');
      const data = new File([await response.blob()], file.name, { type: file.mime });
      if (!navigator.canShare?.({ files: [data] }))
        throw new Error(
          'Condivisione non disponibile: usa Scarica e condividi il file dal dispositivo.',
        );
      // A second tap preserves the user gesture required by iOS after downloading.
      setPrepared({ id: file.id, file: data });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setSharing(null);
    }
  }
  return (
    <div className="file-cards">
      {files.map((file) => {
        const url = `/api/conversations/${chatId}/files/${file.id}`;
        return (
          <div className="file-card" key={file.id}>
            <strong>{file.name}</strong>
            <div>
              {isMarkdown(file.name, file.mime) ? (
                <button
                  onClick={() =>
                    onRead({
                      key: `attachment:${chatId}:${file.id}`,
                      name: file.name,
                      url,
                      chatId,
                      attachmentId: file.id,
                    })
                  }
                >
                  Apri
                </button>
              ) : (
                <a href={url + '?open=1'} target="_blank" rel="noreferrer">
                  Apri
                </a>
              )}
              <a href={url} download={file.name}>
                Scarica
              </a>
              {!!navigator.share && (
                <button type="button" disabled={!!sharing} onClick={() => void share(file)}>
                  {sharing === file.id
                    ? 'Preparazione…'
                    : prepared?.id === file.id
                      ? 'Condividi file'
                      : 'Condividi'}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {prepared && <p role="status">File pronto: tocca Condividi file per scegliere l’app.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
