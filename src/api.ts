import type {
  Conversation,
  Message,
  Run,
  Activity,
  RunStatus,
  WorkspaceMode,
} from '../server/store';
export type { WorkspaceMode };
export type Chat = Conversation & {
  status?: RunStatus | null;
  unread_count?: number;
  actualModel?: { id: string; state: 'running' | 'last' } | null;
  modelPending?: boolean;
  contextUsage?: {
    inputTokens: number;
    contextWindow: number | null;
    observedAt: number;
    state: 'running' | 'last';
  } | null;
};
export type Detail = Chat & {
  messages: Message[];
  runs: Run[];
  activity: Activity[];
  queue: Message[];
};
export interface Settings {
  demo: boolean;
  voiceAvailable: boolean;
  pushPublicKey: string | null;
  maxRuns: number;
  unrestricted: boolean;
  workspaceMode: WorkspaceMode;
}
export interface GitHubInfo {
  connected: boolean;
  login: string | null;
  repositories: { fullName: string; private: boolean }[];
  owners: { login: string; type: 'User' | 'Organization' }[];
  error?: string;
}
export interface AudioPreferences {
  sttModel: string;
  ttsModel: string;
  voice: string;
}
export interface AudioSettings extends AudioPreferences {
  defaults: AudioPreferences;
}
export interface AudioCatalog {
  stt: { id: string; name: string }[];
  tts: { id: string; name: string }[];
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, body?: unknown, keepalive = false): Promise<T> {
  const form = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    keepalive,
    headers: body !== undefined && !form ? { 'Content-Type': 'application/json' } : {},
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error || `Richiesta non riuscita (${res.status}).`, res.status);
  }
  return res.json();
}
export function busy(status?: string | null) {
  return status === 'running' || status === 'transcribing';
}
