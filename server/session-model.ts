import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { modelSchema } from './agent-models';

export function reportedModel(value: unknown): string | null {
  const parsed = modelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
