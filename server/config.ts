import 'dotenv/config';
import path from 'node:path';

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  origin: string;
  password: string;
  demo: boolean;
  maxRuns: number;
  unrestricted: boolean;
  claudeBin: string;
  codexBin: string;
  audioKey: string;
  audioBase: string;
  sttModel: string;
  ttsModel: string;
  voice: string;
  vapidPublic: string;
  vapidPrivate: string;
  vapidSubject: string;
  workspaceMode: 'isolated' | 'shared';
}
export function readConfig(): Config {
  const config = {
    dataDir: path.resolve(process.env.DATA_DIR || '.data'),
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 4310),
    origin: process.env.APP_ORIGIN || 'http://localhost:5173',
    password: process.env.APP_PASSWORD || '',
    demo: process.env.DEMO_MODE === 'true',
    maxRuns: Number(process.env.MAX_CONCURRENT_RUNS || 3),
    unrestricted: process.env.AGENT_UNRESTRICTED === 'true',
    claudeBin: process.env.CLAUDE_BIN || 'claude',
    codexBin: process.env.CODEX_BIN || 'codex',
    audioKey: process.env.OPENROUTER_API_KEY || '',
    audioBase: process.env.AUDIO_BASE_URL || 'https://openrouter.ai/api/v1',
    sttModel: process.env.STT_MODEL || 'openai/gpt-4o-transcribe',
    ttsModel: process.env.TTS_MODEL || 'google/gemini-3.8-flash-lite-tts',
    voice: process.env.TTS_VOICE || 'Kore',
    vapidPublic: process.env.VAPID_PUBLIC_KEY || '',
    vapidPrivate: process.env.VAPID_PRIVATE_KEY || '',
    vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    workspaceMode: (process.env.WORKSPACE_MODE || 'isolated') as Config['workspaceMode'],
  };
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.host) && config.password.length < 24)
    throw new Error('APP_PASSWORD deve contenere almeno 24 caratteri per esporre il server.');
  if (!Number.isInteger(config.maxRuns) || config.maxRuns < 1 || config.maxRuns > 16)
    throw new Error('MAX_CONCURRENT_RUNS deve essere compreso tra 1 e 16.');
  if (!['isolated', 'shared'].includes(config.workspaceMode))
    throw new Error('WORKSPACE_MODE deve essere isolated oppure shared.');
  return config;
}
