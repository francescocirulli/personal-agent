import { reportedModel } from './session-model';

export type Normalized = {
  type: 'session' | 'model' | 'text' | 'status' | 'failure';
  value: string;
};
// Only selected protocol fields reach the UI; no raw tool output, credentials or reasoning.
export function normalize(agent: 'claude' | 'codex', e: any): Normalized[] {
  const out: Normalized[] = [];
  if (agent === 'claude') {
    if (e.type === 'system' && e.subtype === 'init' && e.session_id)
      out.push({ type: 'session', value: e.session_id });
    const model = reportedModel(
      e.type === 'system' && e.subtype === 'init'
        ? e.model
        : e.type === 'assistant' && !e.parent_tool_use_id
          ? e.message?.model
          : null,
    );
    if (model) out.push({ type: 'model', value: model });
    if (e.type === 'assistant' && !e.parent_tool_use_id)
      for (const b of e.message?.content || []) {
        if (b.type === 'text') out.push({ type: 'text', value: b.text });
        if (b.type === 'tool_use') out.push({ type: 'status', value: toolStatus(b.name) });
      }
    if (e.type === 'result' && e.is_error)
      out.push({
        type: 'failure',
        value:
          'Claude Code non ha completato il turno. Verifica accesso, limiti e configurazione della CLI.',
      });
    if (e.type === 'result' && !e.is_error && typeof e.result === 'string')
      out.push({ type: 'text', value: e.result });
  } else {
    if (e.type === 'thread.started' && e.thread_id)
      out.push({ type: 'session', value: e.thread_id });
    if (e.type === 'item.completed' && e.item?.type === 'agent_message')
      out.push({ type: 'text', value: e.item.text });
    if (e.type === 'item.started' && e.item)
      out.push({ type: 'status', value: toolStatus(e.item.type) });
    if (e.type === 'turn.failed' || e.type === 'error')
      out.push({
        type: 'failure',
        value:
          'Codex non ha completato il turno. Verifica accesso, limiti e configurazione della CLI.',
      });
  }
  return out;
}
export function toolStatus(tool: string) {
  if (/browser/i.test(tool)) return 'Sto usando il browser. Puoi aprire la vista dalla chat.';
  if (/Read|Glob|Grep|web_search/i.test(tool)) return 'Sto cercando le informazioni utili.';
  if (/Edit|Write|file_change/i.test(tool)) return 'Sto aggiornando i file.';
  if (/Bash|command_execution/i.test(tool)) return 'Sto eseguendo un comando.';
  if (/mcp/i.test(tool)) return 'Sto consultando uno strumento collegato.';
  return 'Sto lavorando alla tua richiesta.';
}
export function splitVoice(raw: string) {
  // Ignore fenced code: sample tags in code are not spoken summaries.
  const prose = raw.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  const tags = [...prose.matchAll(/<voce>([\s\S]*?)<\/voce>/gi)];
  const spoken = tags.at(-1)?.[1]?.trim();
  const awaitingInput = /^[ \t]*<richiesta_input[ \t]*\/>[ \t]*$/im.test(prose);
  const text = raw
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part) =>
      part.startsWith('```') || part.startsWith('~~~')
        ? part
        : part
            .replace(/<voce>[\s\S]*?<\/voce>/gi, '')
            .replace(/^[ \t]*<richiesta_input[ \t]*\/>[ \t]*$/gim, ''),
    )
    .join('')
    .trim();
  const fallback = prose
    .replace(/<[^>]*>/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>]/g, '')
    .trim();
  return {
    awaitingInput,
    text: text || spoken || 'Risposta disponibile.',
    voice: (spoken || fallback || 'La risposta è disponibile nella chat.').slice(0, 12000),
  };
}
