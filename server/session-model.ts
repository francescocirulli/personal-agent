import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { modelSchema } from './agent-models';

export function reportedModel(value: unknown): string | null {
  const parsed = modelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface CodexSessionInfo {
  model: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  observedAt: number | null;
}

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Codex exec JSON does not include the resolved model. Read only the exact
// thread's model metadata, never its transcript, prompt or credentials.
// This is a best-effort adapter to CLI-owned state, not a default-model guess.
export async function codexSessionModel(
  sessionId: string,
  since?: number,
  home = process.env.AGENT_CODEX_HOME || path.join(homedir(), '.codex'),
): Promise<string | null> {
  let db: DatabaseSync | undefined;
  try {
    const files = (await readdir(home))
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (!files.length) return null;
    db = new DatabaseSync(path.join(home, files[0]), { readOnly: true });
    db.exec('PRAGMA busy_timeout=50; PRAGMA query_only=ON;');
    const row = db.prepare('SELECT model, updated_at FROM threads WHERE id=?').get(sessionId);
    if (!row || (since !== undefined && Number(row.updated_at) < Math.floor(since / 1000)))
      return null;
    return reportedModel(row.model);
  } catch {
    // Missing/older schemas and transient locks must never fail an agent run.
    return null;
  } finally {
    db?.close();
  }
}

// Read only a bounded tail of the exact thread's rollout to capture Codex's
// most recent per-request token_count, without exposing or retaining its text.
export async function codexSessionInfo(
  sessionId: string,
  since: number,
  home = process.env.AGENT_CODEX_HOME || path.join(homedir(), '.codex'),
): Promise<CodexSessionInfo> {
  let db: DatabaseSync | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const files = (await readdir(home))
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (!files.length)
      return { model: null, contextTokens: null, contextWindow: null, observedAt: null };
    db = new DatabaseSync(path.join(home, files[0]), { readOnly: true });
    db.exec('PRAGMA busy_timeout=50; PRAGMA query_only=ON;');
    const row = db
      .prepare('SELECT model, updated_at, rollout_path FROM threads WHERE id=?')
      .get(sessionId);
    if (!row) return { model: null, contextTokens: null, contextWindow: null, observedAt: null };
    const model =
      Number(row.updated_at) >= Math.floor(since / 1000) ? reportedModel(row.model) : null;
    const sessionsRoot = await realpath(path.resolve(home, 'sessions'));
    const rolloutPath = await realpath(String(row.rollout_path || ''));
    const relative = path.relative(sessionsRoot, rolloutPath);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      return { model, contextTokens: null, contextWindow: null, observedAt: null };
    file = await open(rolloutPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await file.stat();
    if (!stats.isFile())
      return { model, contextTokens: null, contextWindow: null, observedAt: null };
    const { size } = stats;
    const length = Math.min(size, 256 * 1024);
    if (!length) return { model, contextTokens: null, contextWindow: null, observedAt: null };
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
      let event: any;
      try {
        event = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
      const observedAt = Date.parse(event.timestamp);
      if (!Number.isFinite(observedAt) || observedAt < since) break;
      const info = event.payload.info;
      return {
        model,
        contextTokens: safeCount(info?.last_token_usage?.input_tokens),
        contextWindow: safeCount(info?.model_context_window),
        observedAt,
      };
    }
    return { model, contextTokens: null, contextWindow: null, observedAt: null };
  } catch {
    return { model: null, contextTokens: null, contextWindow: null, observedAt: null };
  } finally {
    await file?.close().catch(() => {});
    db?.close();
  }
}
