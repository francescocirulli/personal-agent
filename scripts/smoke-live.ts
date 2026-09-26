// Explicit live smoke test: uses subscriptions and a short paid TTS/STT request.
// Never run as part of the offline test suite, and never print credentials.
import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { AudioService } from '../server/audio';
import { readConfig } from '../server/config';
const base = process.env.SMOKE_BASE_URL || 'http://localhost:4310';
let cookie = '';
async function request(endpoint: string, body?: unknown) {
  const multipart = body instanceof FormData;
  const res = await fetch(base + '/api' + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Cookie: cookie,
      ...(body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
  });
  if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie')!.split(';')[0];
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
async function wait(chatId: string) {
  for (let i = 0; i < 120; i++) {
    const chat = await request(`/conversations/${chatId}`);
    const run = chat.runs.at(-1);
    if (run.status === 'complete') return chat;
    if (!['running', 'transcribing'].includes(run.status)) throw new Error(run.error);
    await delay(1000);
  }
  await request(`/conversations/${chatId}/cancel`, {});
  throw new Error('Timeout di verifica; task fermato.');
}
await request('/login', { password: process.env.APP_PASSWORD });
let failed = false;
for (const agent of (process.env.SMOKE_AGENTS ?? 'codex,claude').split(',').filter(Boolean)) {
  try {
    const chat = await request('/conversations', {
      agent,
      title: `Verifica collegamento · ${agent}`,
      repo: null,
    });
    await request(`/conversations/${chat.id}/turns`, {
      text: 'Questa è una verifica tecnica della chat. Memorizza il codice marea-731. Rispondi brevemente che il collegamento funziona, anche nel tag voce. Non usare strumenti e non modificare file.',
    });
    const first = await wait(chat.id);
    if (!first.session_id) throw new Error('Sessione non salvata.');
    console.log(`${agent}: primo turno riuscito, sessione salvata.`);
    await request(`/conversations/${chat.id}/turns`, {
      text: 'Quale codice ti ho chiesto di memorizzare? Rispondi brevemente e includilo anche nel tag voce. Non usare strumenti.',
    });
    const resumed = await wait(chat.id),
      message = resumed.messages.at(-1);
    if (resumed.session_id !== first.session_id || !message.text.includes('marea-731'))
      throw new Error('Contesto non conservato nella ripresa.');
    console.log(`${agent}: ripresa della conversazione e memoria verificate.`);
    const audio = await request(`/conversations/${chat.id}/messages/${message.id}/audio`, {});
    const response = await fetch(base + audio.url, { headers: { Cookie: cookie } });
    if (!response.ok || (await response.arrayBuffer()).byteLength < 1000)
      throw new Error('Audio non valido.');
    console.log(`${agent}: pulsante Ascolta verificato via API.`);
  } catch (e) {
    failed = true;
    console.error(`${agent}: ${(e as Error).message}`);
  }
}
if (process.env.SMOKE_AUDIO_INPUT === 'true') {
  try {
    const service = new AudioService(readConfig());
    const key = await service.speech(
      'Rispondi con una breve frase di saluto. Non usare strumenti.',
    );
    const clip = await service.read(key);
    const chat = await request('/conversations', {
      agent: 'codex',
      title: 'Verifica voce completa',
      repo: null,
    });
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(clip)], { type: service.mime }), 'prova.wav');
    await request(`/conversations/${chat.id}/turns`, form);
    const result = await wait(chat.id);
    if (!result.messages.some((m: any) => m.role === 'user' && /saluto/i.test(m.text)))
      throw new Error('Trascrizione non conservata.');
    const message = result.messages.at(-1);
    await request(`/conversations/${chat.id}/messages/${message.id}/audio`, {});
    console.log(
      'Flusso audio caricato → STT → Codex → risposta TTS verificato. Microfono fisico non incluso.',
    );
  } catch (e) {
    failed = true;
    console.error((e as Error).message);
  }
}
if (failed) process.exitCode = 1;
