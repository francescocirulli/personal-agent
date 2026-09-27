import { useEffect, useState } from 'react';
import { api, type Chat } from './api';
import type { DiffView } from '../server/git-diff';

export type DiffMode = 'local' | 'branch';

// Prefer local work; after a commit keep the branch comparison within reach.
// Use Git's total, never the length of the capped file list.
export function useWorkChanges(chat: Chat) {
  const [changes, setChanges] = useState<{ mode: DiffMode; total: number; base: string | null }>();
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let again = false;
    setChanges(undefined);
    if (!chat.repo && !chat.workspace) return;
    const refresh = async () => {
      if (disposed || document.hidden) return;
      if (pending) {
        again = true;
        return;
      }
      pending = true;
      try {
        let view = await api<DiffView>(`/conversations/${chat.id}/diff?mode=local`);
        if (view.git.ready && !view.total && !disposed) {
          let base = '';
          try {
            base = localStorage.getItem(`diff-base:${chat.id}`) || '';
          } catch {
            /* Optional preference. */
          }
          const query = new URLSearchParams({ mode: 'branch', ...(base ? { base } : {}) });
          view = await api<DiffView>(`/conversations/${chat.id}/diff?${query}`);
        }
        if (!disposed)
          setChanges(
            view.git.ready && view.total > 0
              ? { mode: view.mode, total: view.total, base: view.base }
              : undefined,
          );
      } catch {
        // Unknown is not zero: keep the manual review entry available in the composer.
        if (!disposed) setChanges(undefined);
      } finally {
        pending = false;
        if (again && !disposed) {
          again = false;
          void refresh();
        }
      }
    };
    void refresh();
    const timer = setInterval(refresh, 15000);
    window.addEventListener('git-change', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('git-change', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [chat.id, chat.repo, chat.workspace]);
  return changes;
}
