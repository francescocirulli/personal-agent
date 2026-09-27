import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CircleDot, CircleX, TriangleAlert, ChevronDown } from 'lucide-react';
import type { Activity } from '../server/store';

export function ActivityPanel({
  activity,
  open,
  onOpenChange,
}: {
  activity: Activity[];
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const id = useId();
  const [availableHeight, setAvailableHeight] = useState(280);
  const panel = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    const container = panel.current.closest('.messages');
    if (!container) return;
    const update = () => setAvailableHeight(Math.max(60, container.clientHeight - 150));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [open]);
  useLayoutEffect(() => {
    if (open) panel.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [open, availableHeight]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target))
        onOpenChange(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, onOpenChange]);
  const close = () => {
    onOpenChange(false);
    toggle.current?.focus({ preventScroll: true });
  };
  return (
    <section
      className="activity"
      ref={panel}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={toggle}
        className="activity-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onOpenChange(!open)}
      >
        Attività del lavoro
        <span className="activity-count" aria-hidden="true">
          {activity.length}
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div id={id} hidden={!open}>
        {open && (
          <>
            <div
              className="activity-list"
              style={{ maxHeight: `min(34dvh, ${availableHeight}px, 280px)` }}
              role="region"
              aria-label="Elenco attività"
              tabIndex={0}
            >
              <ol>
                {activity.map((item) => (
                  <li key={item.id} className={`activity-${item.kind || 'info'}`}>
                    {item.kind === 'error' ? (
                      <CircleX size={14} aria-label="Errore" />
                    ) : item.kind === 'warning' ? (
                      <TriangleAlert size={14} aria-label="Avviso" />
                    ) : (
                      <CircleDot size={14} aria-label="Attività" />
                    )}
                    <span>{item.text}</span>
                    <time dateTime={new Date(item.created_at).toISOString()}>
                      {new Date(item.created_at).toLocaleTimeString('it-IT', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </li>
                ))}
              </ol>
            </div>
            <button className="activity-close" onClick={close}>
              Chiudi attività
            </button>
          </>
        )}
      </div>
    </section>
  );
}
