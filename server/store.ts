import type { Effort } from './agent-effort';
import type { ChatImage } from './images';
import type { ChatFile } from './files';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type Agent = 'claude' | 'codex';
export type RunStatus =
  'queued' | 'transcribing' | 'running' | 'complete' | 'error' | 'cancelled' | 'interrupted';
export interface Conversation {
  id: string;
  title: string;
  agent: Agent;
  repo: string | null;
  model: string | null;
  effort: Effort;
  session_id: string | null;
  workspace: string | null;
  queue_paused: number;
  created_at: number;
  updated_at: number;
}
export interface Attachment {
  id: string;
  name: string;
  mime: string;
}
export interface Message {
  attachments?: Attachment[];
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
      CREATE TABLE IF NOT EXISTS run_queue (run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, priority INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), run_id TEXT NOT NULL REFERENCES runs(id), role TEXT NOT NULL, text TEXT NOT NULL, voice_text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, name TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
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
    if (
      !this.db
        .prepare('PRAGMA table_info(conversations)')
        .all()
        .some((c) => c.name === 'model')
    )
      this.db.exec('ALTER TABLE conversations ADD COLUMN model TEXT');
    if (
      !this.db
        .prepare('PRAGMA table_info(conversations)')
        .all()
        .some((c) => c.name === 'effort')
    )
      this.db.exec("ALTER TABLE conversations ADD COLUMN effort TEXT NOT NULL DEFAULT 'high'");
    if (
      !this.db
        .prepare('PRAGMA table_info(conversations)')
        .all()
        .some((c) => c.name === 'queue_paused')
    )
      this.db.exec('ALTER TABLE conversations ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0');
    if (
      !this.db
        .prepare('PRAGMA table_info(run_queue)')
        .all()
        .some((c) => c.name === 'bypass_pause')
    )
      this.db.exec('ALTER TABLE run_queue ADD COLUMN bypass_pause INTEGER NOT NULL DEFAULT 0');
    this.db.function('search_fold', { deterministic: true }, (value) =>
      String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase(),
    );
    this.db
      .prepare(
        "UPDATE runs SET status='interrupted',error='Il server è stato riavviato. Il lavoro non viene rieseguito automaticamente.',updated_at=? WHERE status IN ('running','transcribing')",
      )
      .run(Date.now());
  }
  list() {
    return this.db
      .prepare(
        `SELECT c.*, (SELECT status FROM runs WHERE conversation_id=c.id ORDER BY CASE WHEN status IN ('running','transcribing') THEN 0 WHEN status='queued' THEN 1 ELSE 2 END,created_at DESC,rowid DESC LIMIT 1) AS status FROM conversations c ORDER BY updated_at DESC`,
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
    const messages = this.db
      .prepare(
        "SELECT m.* FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.conversation_id=? AND r.status<>'queued' ORDER BY m.created_at,m.rowid",
      )
      .all(id) as unknown as Message[];
    return messages.map((m) => ({ ...m, attachments: this.attachments(m.id) }));
  }
  attachments(messageId: string) {
    return this.db
      .prepare('SELECT id,name,mime FROM attachments WHERE message_id=? ORDER BY rowid')
      .all(messageId) as unknown as Attachment[];
  }
  messageFiles(messageId: string): ChatFile[] {
    return this.db
      .prepare('SELECT name,mime,data FROM attachments WHERE message_id=? ORDER BY rowid')
      .all(messageId)
      .map((row) => ({
        name: String(row.name),
        mime: String(row.mime),
        data: Buffer.from(row.data as Uint8Array),
      }));
  }
  messageImages(messageId: string): ChatImage[] {
    return this.messageFiles(messageId).filter((f) => f.mime === 'image/jpeg') as ChatImage[];
  }
  search(query: string, offset = 0) {
    const rows = this.db
      .prepare(
        `SELECT m.id,m.conversation_id,m.role,c.title,m.created_at,
      substr(m.text,max(1,instr(search_fold(m.text),search_fold(?))-65),240) AS excerpt
      FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN runs r ON r.id=m.run_id
      WHERE r.status<>'queued' AND instr(search_fold(m.text),search_fold(?))>0
      ORDER BY m.created_at DESC,m.rowid DESC LIMIT 41 OFFSET ?`,
      )
      .all(query, query, offset);
    return { results: rows.slice(0, 40), hasMore: rows.length > 40 };
  }
  queue(conversationId: string) {
    return (
      this.db
        .prepare(
          `SELECT m.* FROM messages m JOIN runs r ON r.id=m.run_id
      JOIN run_queue q ON q.run_id=r.id WHERE r.conversation_id=? AND r.status='queued'
      ORDER BY q.priority DESC,r.created_at,r.rowid`,
        )
        .all(conversationId) as unknown as Message[]
    ).map((m) => ({ ...m, attachments: this.attachments(m.id) }));
  }
  enqueue(conversationId: string, text: string, images: ChatFile[]) {
    const runId = randomUUID(),
      now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)')
        .run(runId, conversationId, 'queued', null, now, now);
      this.writeMessage(conversationId, runId, 'user', text, '', images);
      this.db.prepare('INSERT INTO run_queue(run_id) VALUES (?)').run(runId);
      this.touch(conversationId);
      this.db.exec('COMMIT');
      return runId;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  fork(conversationId: string, messageId: string) {
    const source = this.conversation(conversationId)!;
    const history = this.messages(conversationId);
    const index = history.findIndex((m) => m.id === messageId && m.role === 'assistant');
    if (index < 0) throw new Error('Risposta non trovata.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const chat = this.create(source.agent, source.repo, `${source.title.slice(0, 90)} · Fork`);
      this.db
        .prepare('UPDATE conversations SET model=?,effort=?,title_custom=1 WHERE id=?')
        .run(source.model, source.effort, chat.id);
      const runs = new Map<string, string>();
      for (const message of history.slice(0, index + 1)) {
        let runId = runs.get(message.run_id);
        if (!runId) {
          runId = randomUUID();
          runs.set(message.run_id, runId);
          const original = this.db.prepare('SELECT * FROM runs WHERE id=?').get(message.run_id)!;
          this.db
            .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)')
            .run(
              runId,
              chat.id,
              original.status,
              original.error,
              original.created_at,
              original.updated_at,
            );
        }
        const id = this.writeMessage(
          chat.id,
          runId,
          message.role,
          message.text,
          message.voice_text,
          this.messageFiles(message.id),
        );
        this.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(message.created_at, id);
      }
      this.db.exec('COMMIT');
      return this.conversation(chat.id)!;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
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
    images: ChatFile[] = [],
  ) {
    this.db.exec('BEGIN IMMEDIATE');
    let id: string;
    try {
      id = this.writeMessage(conversationId, runId, role, text, voice, images);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.touch(conversationId);
    return this.message(id)!;
  }
  private writeMessage(
    conversationId: string,
    runId: string,
    role: Message['role'],
    text: string,
    voice: string,
    images: ChatFile[],
  ) {
    const id = randomUUID();
    const last = this.db
      .prepare('SELECT max(created_at) AS time FROM messages WHERE conversation_id=?')
      .get(conversationId)?.time;
    this.db
      .prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)')
      .run(id, conversationId, runId, role, text, voice, Math.max(Date.now(), Number(last || 0)));
    for (const image of images)
      this.db
        .prepare('INSERT INTO attachments VALUES (?,?,?,?,?)')
        .run(randomUUID(), id, image.name, image.mime, image.data);
    return id;
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
