import { parseAgentCommand } from '../src/agentCommands';
import { agentEnvironment, commandFor, runProcess, type runAgent } from './runner';
import { codexRpc, CodexRpcError } from './codex-rpc';
import { codexSessionInfo, reportedModel } from './session-model';

const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const number = (value: unknown) =>
  count(value) ? value.toLocaleString('it-IT') : 'Non disponibile';
const label = (value: unknown) =>
  typeof value === 'string'
    ? value.replace(/[^\p{L}\p{N} ._/-]/gu, '').slice(0, 120)
    : 'Non disponibile';

export function formatCodexUsage(usage: any, limits: any) {
  const rows = [
    '**Consumi account Codex**',
    `Token complessivi: **${number(usage?.summary?.lifetimeTokens)}**`,
    `Massimo giornaliero: **${number(usage?.summary?.peakDailyTokens)}** token`,
  ];
  const buckets = limits?.rateLimitsByLimitId
    ? Object.values(limits.rateLimitsByLimitId)
    : limits?.rateLimits
      ? [limits.rateLimits]
      : [];
  for (const bucket of buckets.slice(0, 12) as any[]) {
    rows.push(`**${label(bucket.limitName || bucket.limitId || 'Limiti Codex')}**`);
    for (const key of ['primary', 'secondary']) {
      const window = bucket[key];
      if (!window || !count(window.usedPercent)) continue;
      const reset =
        count(window.resetsAt) && window.resetsAt < 8_640_000_000_000
          ? new Date(window.resetsAt * 1000)
              .toISOString()
              .replace('T', ' ')
              .replace('.000Z', ' UTC')
          : null;
      rows.push(
        `- Finestra ${count(window.windowDurationMins) ? `${number(window.windowDurationMins)} min` : key === 'primary' ? 'primaria' : 'secondaria'}: **${window.usedPercent}% utilizzato**${reset ? ` · rinnovo ${reset}` : ''}`,
      );
    }
  }
  if (!limits) rows.push('Limiti dell’account non disponibili dalla CLI.');
  if (!usage) rows.push('Statistiche dell’account non disponibili dalla CLI.');
  rows.push('Questi dati riguardano l’account; non indicano quanto contesto occupa questa chat.');
  return rows.join('\n\n');
}

export async function runAgentCommand(...args: Parameters<typeof runAgent>) {
  const [config, chat, input, outerSignal, emit, access] = args;
  const command = parseAgentCommand(chat.agent, input);
  if (!command) throw new Error('Comando non riconosciuto.');
  const signal = AbortSignal.any([
    outerSignal,
    AbortSignal.timeout(command === '/compact' ? 180_000 : 60_000),
  ]);
  emit({
    type: 'status',
    value:
      command === '/compact' ? 'Compatto il contesto della chat…' : `Leggo ${command} dalla CLI…`,
  });
  if (config.demo) {
    emit({
      type: 'text',
      value: `**${command} · Dimostrazione**\n\nNessun comando CLI è stato eseguito. In modalità reale qui comparirà il risultato del comando.`,
    });
    return;
  }
  if (command === '/compact' && !chat.session_id)
    throw new Error('Invia prima un messaggio: non c’è ancora una sessione da compattare.');
  if (chat.agent === 'claude') {
    const { bin, args: cliArgs } = commandFor(config, chat, access?.servers);
    if (!chat.session_id) cliArgs.push('--no-session-persistence');
    let result: string | undefined;
    let failure = false;
    let compacted = false;
    await runProcess(
      bin,
      cliArgs,
      chat.workspace!,
      signal,
      command,
      (line) => {
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === 'system' && event.subtype === 'compact_boundary') compacted = true;
        if (
          event.type === 'assistant' &&
          !event.parent_tool_use_id &&
          event.local_command_run?.command === 'context'
        ) {
          const context = event.context_usage;
          if (count(context?.total_tokens) && count(context?.raw_max_tokens))
            emit({
              type: 'context',
              inputTokens: context.total_tokens,
              contextWindow: context.raw_max_tokens,
            });
        }
        if (event.type === 'result') {
          failure = !!event.is_error;
          // Never accept an ordinary model answer as a successful slash command.
          if (
            (event.local_command === command.slice(1) || (command === '/compact' && compacted)) &&
            typeof event.result === 'string'
          )
            result = event.result;
        }
      },
      { ...agentEnvironment(config), ...access?.env },
    );
    if (failure)
      throw new Error(
        'Claude Code non ha eseguito il comando. Verifica accesso, limiti e sessione.',
      );
    if (command === '/compact' && compacted)
      result = 'Contesto compattato. Puoi continuare questa chat.';
    if (!result?.trim())
      throw new Error(
        'Il comando non ha restituito un risultato supportato da questa versione di Claude Code.',
      );
    result = result.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').slice(0, 40000);
    if (command === '/usage')
      result +=
        '\n\nI valori sono quelli restituiti da Claude Code per questa esecuzione; eventuali zeri non indicano che la quota dell’abbonamento sia inutilizzata.';
    if (command === '/context' && !chat.session_id)
      result +=
        '\n\nContesto iniziale della CLI: la cronologia della chat verrà caricata al primo messaggio.';
    emit({ type: 'text', value: `**${command} · Claude Code**\n\n${result}` });
    return;
  }

  if (command === '/status' && !chat.session_id) {
    emit({
      type: 'text',
      value:
        '**Stato Codex**\n\nNessuna sessione avviata. Invia il primo messaggio per conoscere modello e contesto effettivi.',
    });
    return;
  }
  // Reuse the runner's explicit configuration, including subscription authentication.
  const base = commandFor(config, chat, access?.servers).args;
  const rpcArgs = ['app-server', '--listen', 'stdio://'];
  for (let i = 0; i < base.length; i++) if (base[i] === '-c') rpcArgs.push('-c', base[++i]);
  rpcArgs.push(
    '-c',
    'approval_policy="never"',
    '-c',
    `sandbox_mode="${config.unrestricted ? 'danger-full-access' : 'workspace-write'}"`,
  );
  let completion: (() => void) | undefined;
  let completionError: ((error: Error) => void) | undefined;
  let compactStarted = false;
  let sawCompaction = false;
  const rpc = codexRpc(
    config.codexBin,
    rpcArgs,
    chat.workspace!,
    { ...agentEnvironment(config), ...access?.env },
    signal,
    (method, params) => {
      if (params?.threadId !== chat.session_id) return;
      if (method === 'thread/tokenUsage/updated' && (command !== '/compact' || sawCompaction)) {
        const usage = params.tokenUsage;
        if (count(usage?.last?.inputTokens))
          emit({
            type: 'context',
            inputTokens: usage.last.inputTokens,
            contextWindow: count(usage.modelContextWindow) ? usage.modelContextWindow : null,
          });
      }
      if (!compactStarted) return;
      if (method === 'item/completed' && params.item?.type === 'contextCompaction')
        sawCompaction = true;
      if (method === 'thread/compacted') {
        sawCompaction = true;
        completion?.();
      }
      if (method === 'turn/completed') {
        if (params.turn?.status === 'completed' && sawCompaction) completion?.();
        else completionError?.(new Error('La compattazione non è stata completata.'));
      }
      if (method === 'error')
        completionError?.(new Error('Codex ha segnalato un errore durante la compattazione.'));
    },
  );
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'personal_agent_commands', version: '0.1.0' },
      capabilities: {},
    });
    rpc.notify('initialized');
    if (command === '/usage') {
      const results = await Promise.allSettled([
        rpc.request('account/usage/read'),
        rpc.request('account/rateLimits/read'),
      ]);
      if (results.every((r) => r.status === 'rejected')) throw new CodexRpcError();
      emit({
        type: 'text',
        value: formatCodexUsage(
          results[0].status === 'fulfilled' ? results[0].value : null,
          results[1].status === 'fulfilled' ? results[1].value : null,
        ),
      });
    } else if (command === '/status') {
      const { thread } = await rpc.request('thread/read', {
        threadId: chat.session_id,
        includeTurns: false,
      });
      if (thread?.id !== chat.session_id) throw new CodexRpcError();
      const info = await codexSessionInfo(chat.session_id!, 0);
      const model = reportedModel(thread.model) || info.model;
      const context = count(info.contextTokens)
        ? `${number(info.contextTokens)}${count(info.contextWindow) ? ` / ${number(info.contextWindow)}` : ''} token`
        : 'Non disponibile';
      emit({
        type: 'text',
        value: `**Stato Codex**\n\n- Modello della sessione: **${model || 'Non disponibile'}**\n- Ragionamento: ${label(thread.reasoningEffort)}\n- Contesto dell’ultima richiesta: **${context}**\n\nDati della sessione salvata. Per i limiti dell’account usa /usage.`,
      });
    } else {
      await rpc.request('thread/resume', {
        threadId: chat.session_id,
        cwd: chat.workspace,
        excludeTurns: true,
        approvalPolicy: 'never',
        ...(chat.model ? { model: chat.model } : {}),
      });
      const done = new Promise<void>((resolve, reject) => {
        completion = resolve;
        completionError = reject;
      });
      // Attach the race before sending: completion can precede the RPC acknowledgement.
      const finished = Promise.race([
        done,
        rpc.closed.then(() => {
          throw new CodexRpcError();
        }),
      ]);
      void finished.catch(() => {});
      compactStarted = true;
      await rpc.request('thread/compact/start', { threadId: chat.session_id });
      await finished;
      emit({
        type: 'text',
        value:
          '**Contesto compattato**\n\nCodex ha completato la compattazione. Puoi continuare questa chat.',
      });
    }
  } finally {
    await rpc.close();
  }
}
