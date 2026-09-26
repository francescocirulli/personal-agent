import * as pty from 'node-pty';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, stat, copyFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Response } from 'express';
import type { Config } from './config';
import { agentEnvironment } from './runner';
import { toolEnvironment } from './tool-environment';

export interface TerminalView {
  enabled: boolean;
  id: string | null;
  running: boolean;
  cwd: string;
  home: string;
  toolsPrefix: string;
  exitCode?: number;
  browserRequestId?: number;
}
interface TerminalEvent {
  seq: number;
  type: 'data' | 'exit';
  data?: string;
  exitCode?: number;
}
interface Session {
  id: string;
  cwd: string;
  process: pty.IPty;
  running: boolean;
  exitCode?: number;
  events: TerminalEvent[];
  size: number;
  sequence: number;
  streams: Set<Response>;
  finished: Promise<void>;
  stopTimer?: ReturnType<typeof setTimeout>;
}
export class TerminalError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class TerminalService {
  private current?: Session;
  private browserToken = '';
  private browserRequestId = 0;
  private starting = false;
  private closing = false;
  readonly home: string;
  constructor(
    private config: Config,
    private openBrowser?: (url: string) => Promise<unknown>,
  ) {
    this.home = path.join(config.dataDir, 'home');
  }
  view(): TerminalView {
    const s = this.current;
    return {
      enabled: !this.config.demo && this.config.unrestricted,
      id: s?.id || null,
      running: !!s?.running,
      cwd: s?.cwd || this.home,
      home: this.home,
      toolsPrefix: path.join(this.config.dataDir, 'tools'),
      exitCode: s?.exitCode,
      browserRequestId: this.browserRequestId,
    };
  }
  private session(id: string) {
    if (!this.current || id !== this.current.id)
      throw new TerminalError(404, 'Sessione terminale non trovata. Riapri il pannello.');
    return this.current;
  }
  async start(cwd?: string, cols = 80, rows = 24) {
    if (!this.view().enabled)
      throw new TerminalError(
        403,
        'Il terminale è disponibile nell’ambiente reale con autonomia abilitata.',
      );
    if (this.closing || this.starting)
      throw new TerminalError(409, 'Il terminale si sta avviando o chiudendo. Riprova.');
    if (this.current?.running) return this.view();
    this.starting = true;
    try {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      await mkdir(path.join(this.config.dataDir, 'tools/bin'), { recursive: true, mode: 0o700 });
      const directory = cwd || this.home;
      if (!(await stat(directory).catch(() => null))?.isDirectory())
        throw new TerminalError(
          400,
          'Cartella non disponibile. Esegui prima un task nella chat per preparare la repository.',
        );
      if (this.current) for (const stream of this.current.streams) stream.end();
      const browserBin = path.join(this.config.dataDir, 'terminal-bin');
      await mkdir(browserBin, { recursive: true, mode: 0o700 });
      for (const name of ['pa-browser', 'xdg-open', 'sensible-browser']) {
        await copyFile(
          fileURLToPath(new URL('./terminal-browser.mjs', import.meta.url)),
          path.join(browserBin, name),
        );
        await chmod(path.join(browserBin, name), 0o700);
      }
      this.browserToken = randomBytes(32).toString('hex');
      const env = {
        ...agentEnvironment(this.config),
        HOME: this.home,
        ...toolEnvironment(this.config.dataDir, this.home, process.env.PATH),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        SHELL: '/bin/bash',
        LANG: 'C.UTF-8',
      };
      Object.assign(env, {
        PATH: browserBin + path.delimiter + env.PATH,
        BROWSER: path.join(browserBin, 'pa-browser'),
        PA_TERMINAL_BROWSER_URL: `http://127.0.0.1:${this.config.port}/api/terminal/browser/open`,
        PA_TERMINAL_BROWSER_TOKEN: this.browserToken,
      });
      delete (env as NodeJS.ProcessEnv).NO_COLOR;
      delete (env as NodeJS.ProcessEnv).GIT_TERMINAL_PROMPT;
      if (this.closing) throw new TerminalError(409, 'Il server si sta chiudendo.');
      let terminalProcess: pty.IPty;
      try {
        terminalProcess = pty.spawn(
          '/bin/bash',
          [
            '--noprofile',
            '--rcfile',
            fileURLToPath(new URL('./terminal.bashrc', import.meta.url)),
            '-i',
          ],
          { name: 'xterm-256color', cols, rows, cwd: directory, env },
        );
      } catch {
        throw new TerminalError(
          503,
          'Impossibile avviare la shell. Verifica il supporto PTY nel server.',
        );
      }
      let finish!: () => void;
      const s: Session = {
        id: randomUUID(),
        cwd: directory,
        process: terminalProcess,
        running: true,
        events: [],
        size: 0,
        sequence: 0,
        streams: new Set(),
        finished: new Promise<void>((r) => {
          finish = r;
        }),
      };
      this.current = s;
      terminalProcess.onData((data) => {
        // Bound both replay memory and the per-client HTTP queue.
        for (let i = 0; i < data.length; i += 8192)
          this.emit(s, { type: 'data', data: data.slice(i, i + 8192) });
      });
      terminalProcess.onExit(({ exitCode }) => {
        s.running = false;
        s.exitCode = exitCode;
        clearTimeout(s.stopTimer);
        this.emit(s, { type: 'exit', exitCode });
        for (const stream of s.streams) stream.end();
        finish();
      });
      return this.view();
    } finally {
      this.starting = false;
    }
  }
  async browserRequest(authorization: string | undefined, url: string) {
    const provided = Buffer.from(authorization || '');
    const expected = Buffer.from(`Bearer ${this.browserToken}`);
    if (
      !this.browserToken ||
      !this.current?.running ||
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    )
      throw new TerminalError(401, 'Sessione terminale non autorizzata.');
    if (!this.openBrowser) throw new TerminalError(503, 'Browser non disponibile.');
    await this.openBrowser(url);
    this.browserRequestId++;
  }
  private send(res: Response, event: TerminalEvent) {
    if (res.writableEnded || res.destroyed) return;
    if (!res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)) res.end();
  }
  private emit(s: Session, event: Omit<TerminalEvent, 'seq'>) {
    const item = { ...event, seq: ++s.sequence };
    s.events.push(item);
    s.size += (item.data?.length || 0) + 64;
    while (s.size > 262144 && s.events.length > 1) {
      const old = s.events.shift()!;
      s.size -= (old.data?.length || 0) + 64;
    }
    for (const res of s.streams) this.send(res, item);
  }
  stream(id: string, after: number, res: Response) {
    const s = this.session(id);
    if (s.streams.size >= 6)
      throw new TerminalError(429, 'Troppe viste del terminale aperte. Chiudine una e riprova.');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (after > s.sequence || (s.events[0] && after < s.events[0].seq - 1)) {
      res.write(
        `event: reset\ndata: ${JSON.stringify({ message: 'Le righe più vecchie non sono più disponibili.' })}\n\n`,
      );
      after = 0;
    }
    for (const event of s.events)
      if (event.seq > after && !res.writableEnded) this.send(res, event);
    if (!s.running || res.writableEnded) {
      res.end();
      return;
    }
    s.streams.add(res);
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      if (!res.write(': keepalive\n\n')) res.end();
    }, 15000);
    res.once('close', () => {
      clearInterval(heartbeat);
      s.streams.delete(res);
    });
  }
  input(id: string, data: string) {
    const s = this.session(id);
    if (!s.running) throw new TerminalError(409, 'La sessione è terminata. Avviane una nuova.');
    s.process.write(data);
  }
  resize(id: string, cols: number, rows: number) {
    const s = this.session(id);
    if (s.running) s.process.resize(cols, rows);
  }
  async stop(id: string) {
    const s = this.session(id);
    if (!s.running) return;
    s.process.kill('SIGHUP');
    s.stopTimer = setTimeout(() => {
      if (s.running) s.process.kill('SIGKILL');
    }, 2000);
    s.stopTimer.unref();
    await s.finished;
  }
  async close() {
    this.closing = true;
    if (this.current) await this.stop(this.current.id);
  }
}
