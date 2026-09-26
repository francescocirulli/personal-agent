import { useEffect, useState } from 'react';

export function ImageAttachments({
  files,
  disabled,
  onRemove,
}: {
  files: File[];
  disabled: boolean;
  onRemove(index: number): void;
}) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const next = files.map((file) => URL.createObjectURL(file));
    setUrls(next);
    return () => next.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  return (
    <div className="image-attachments" aria-label="Allegati da inviare">
      {files.map((file, index) => (
        <div className="image-draft" key={index}>
          {file.type.startsWith('image/') && urls[index] && (
            <img src={urls[index]} alt={file.name} />
          )}
          <span>{file.name}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRemove(index)}
            aria-label={`Rimuovi allegato ${index + 1}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
