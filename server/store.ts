import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type Agent = 'claude' | 'codex';
export type RunStatus =
  'transcribing' | 'running' | 'complete' | 'error' | 'cancelled' | 'interrupted';
export interface Conversation {
  id: string;
  title: string;
  agent: Agent;
  repo: string | null;
  session_id: string | null;
  workspace: string | null;
  created_at: number;
  updated_at: number;
}
export interface Message {
  id: string;
  conversation_id: string;
  run_id: string;
  role: 'user' | 'assistant';
  text: string;
  voice_text: string;
  created_at: number;
}
export interface Run {
  id: string;
  conversation_id: string;
  status: RunStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
}
export interface Activity {
  id: number;
  conversation_id: string;
  run_id: string;
  text: string;
  created_at: number;
}
export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, 'agent.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL, repo TEXT, session_id TEXT, workspace TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(conversation_id) WHERE status IN ('running','transcribing');
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), run_id TEXT NOT NULL REFERENCES runs(id), role TEXT NOT NULL, text TEXT NOT NULL, voice_text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id), run_id TEXT NOT NULL REFERENCES runs(id), text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (endpoint TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    if (
      !this.db
        .prepare('PRAGMA table_info(conversations)')
        .all()
        .some((c) => c.name === 'title_custom')
    )
      this.db.exec('ALTER TABLE conversations ADD COLUMN title_custom INTEGER NOT NULL DEFAULT 0');
    this.db
      .prepare(
        "UPDATE runs SET status='interrupted',error='Il server è stato riavviato. Il lavoro non viene rieseguito automaticamente.',updated_at=? WHERE status IN ('running','transcribing')",
      )
      .run(Date.now());
  }
  list() {
    return this.db
      .prepare(
        `SELECT c.*, (SELECT status FROM runs WHERE conversation_id=c.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS status FROM conversations c ORDER BY updated_at DESC`,
      )
      .all() as unknown as (Conversation & { status: RunStatus | null })[];
  }
  conversation(id: string) {
    return this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as unknown as
      Conversation | undefined;
  }
  create(agent: Agent, repo: string | null, title: string) {
    const id = randomUUID(),
      now = Date.now();
    this.db
      .prepare(
        'INSERT INTO conversations(id,title,agent,repo,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(id, title, agent, repo, now, now);
    return this.conversation(id)!;
  }
  messages(id: string) {
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,rowid')
      .all(id) as unknown as Message[];
  }
  rename(id: string, title: string) {
    this.db
      .prepare('UPDATE conversations SET title=?,title_custom=1,updated_at=? WHERE id=?')
      .run(title, Date.now(), id);
  }
  remove(id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['messages', 'activity', 'runs'])
        this.db.prepare(`DELETE FROM ${table} WHERE conversation_id=?`).run(id);
      // Preserve monotonically increasing SSE IDs while removing conversation content.
      this.db
        .prepare(
          "UPDATE events SET data=json_object('type','deleted','conversationId',?) WHERE json_extract(data,'$.conversationId')=?",
        )
        .run(id, id);
      this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  setting(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  saveSetting(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  message(id: string) {
    return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as unknown as
      Message | undefined;
  }
  runs(id: string) {
    return this.db
      .prepare('SELECT * FROM runs WHERE conversation_id=? ORDER BY created_at,rowid')
      .all(id) as unknown as Run[];
  }
  activities(id: string) {
    return this.db
      .prepare(
        'SELECT * FROM (SELECT * FROM activity WHERE conversation_id=? ORDER BY id DESC LIMIT 100) ORDER BY id',
      )
      .all(id) as unknown as Activity[];
  }
  addMessage(
    conversationId: string,
    runId: string,
    role: Message['role'],
    text: string,
    voice = '',
  ) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)')
      .run(id, conversationId, runId, role, text, voice, Date.now());
    this.touch(conversationId);
    return this.message(id)!;
  }
  touch(id: string) {
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(Date.now(), id);
  }
  activity(chat: string, run: string, text: string) {
    const now = Date.now();
    const result = this.db
      .prepare('INSERT INTO activity(conversation_id,run_id,text,created_at) VALUES (?,?,?,?)')
      .run(chat, run, text, now);
    return {
      id: Number(result.lastInsertRowid),
      conversation_id: chat,
      run_id: run,
      text,
      created_at: now,
    };
  }
  setRun(id: string, status: RunStatus, error: string | null = null) {
    this.db
      .prepare('UPDATE runs SET status=?,error=?,updated_at=? WHERE id=?')
      .run(status, error, Date.now(), id);
  }
  close() {
    this.db.close();
  }
}
