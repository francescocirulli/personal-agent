import { spawn } from 'node:child_process';

type Packet = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number };
};
export class CodexRpcError extends Error {
  constructor(public code?: number) {
    super('Codex non ha eseguito il comando. Verifica versione della CLI, sessione e accesso.');
  }
}

// One short-lived app-server per scheduled command; never share a thread writer with exec.
export function codexRpc(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onEvent: (method: string, params: any) => void,
) {
  signal.throwIfAborted();
  const child = spawn(bin, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: 'pipe',
  });
  let nextId = 0,
    buffer = '',
    failure: Error | undefined,
    stopping = false;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (name: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {}
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), 2000);
    killTimer.unref();
  };
  const fail = (error: Error) => {
    failure ??= error;
    for (const call of pending.values()) call.reject(failure);
    pending.clear();
    stop();
  };
  const abort = () => fail(new Error('Comando interrotto o scaduto.'));
  signal.addEventListener('abort', abort, { once: true });
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      if (stopping) kill('SIGKILL');
      signal.removeEventListener('abort', abort);
      clearTimeout(killTimer);
      for (const call of pending.values()) call.reject(failure ?? new CodexRpcError());
      pending.clear();
      failure ??= new CodexRpcError();
      resolve();
    });
  });
  const send = (packet: object) => {
    if (failure) throw failure;
    child.stdin.write(JSON.stringify(packet) + '\n');
  };
  child.on('error', () => fail(new Error('Impossibile avviare Codex App Server.')));
  child.stdin.on('error', () => fail(new CodexRpcError()));
  child.stderr.resume(); // Diagnostics may contain credentials or private content.
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 2_000_000) return fail(new Error('Risposta del comando troppo grande.'));
    let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const packet = JSON.parse(line) as Packet;
        if (packet.method && packet.id !== undefined) {
          // No interactive approvals or tool execution during these diagnostic commands.
          send({ id: packet.id, error: { code: -32601, message: 'Unsupported client request' } });
        } else if (packet.id !== undefined) {
          const call = pending.get(Number(packet.id));
          if (!call) continue;
          pending.delete(Number(packet.id));
          if (packet.error) call.reject(new CodexRpcError(packet.error.code));
          else call.resolve(packet.result);
        } else if (packet.method) onEvent(packet.method, packet.params);
      } catch {
        fail(new CodexRpcError());
      }
    }
  });
  return {
    closed,
    request(method: string, params: object = {}): Promise<any> {
      if (failure) return Promise.reject(failure);
      signal.throwIfAborted();
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          send({ id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    notify(method: string) {
      send({ method });
    },
    async close() {
      stop();
      await closed;
    },
  };
}
