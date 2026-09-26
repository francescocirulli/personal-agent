import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { agentEnvironment, runProcess } from '../server/runner';
import { TerminalService } from '../server/terminal';

test(
  'terminal: authenticated real PTY, interactive input, resize, Ctrl+C, reconnect and persistent CLI shared with agents',
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pa-terminal-'));
    const config = {
      ...readConfig(),
      dataDir: dir,
      demo: false,
      unrestricted: true,
      password: 'terminal-test-password-24-characters',
      vapidPublic: '',
      vapidPrivate: '',
    };
    const runtime = createApp(config);
    const server = runtime.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    config.port = (server.address() as any).port;
    config.origin = `http://127.0.0.1:${config.port}`;
    let cookie = '';
    const request = (p: string, body?: unknown, origin?: string) =>
      fetch(config.origin + '/api' + p, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          ...(origin ? { Origin: origin } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const aborts: AbortController[] = [];
    async function listen(id: string, after = 0) {
      const controller = new AbortController();
      aborts.push(controller);
      const response = await fetch(config.origin + `/api/terminal/${id}/events?after=${after}`, {
        headers: { Cookie: cookie },
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      let output = '',
        seq = after,
        pending = '';
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let end;
            while ((end = pending.indexOf('\n\n')) !== -1) {
              const event = pending.slice(0, end);
              pending = pending.slice(end + 2);
              const data = event.split('\n').find((line) => line.startsWith('data: '));
              if (!data) continue;
              const parsed = JSON.parse(data.slice(6));
              seq = parsed.seq || seq;
              if (parsed.type === 'data') output += parsed.data;
            }
          }
        } catch {
          /* Stream cancellation is expected. */
        }
      })();
      return {
        close: () => controller.abort(),
        seq: () => seq,
        output: () => output,
        wait: async (marker: string) => {
          for (let i = 0; i < 300; i++) {
            if (output.includes(marker)) return;
            await delay(30);
          }
          assert.fail(`Terminal did not produce ${marker}; output: ${output.slice(-3000)}`);
        },
      };
    }
    let restarted: TerminalService | undefined;
    try {
      assert.equal((await request('/terminal')).status, 401);
      assert.equal((await request('/terminal/start', { cols: 80, rows: 24 })).status, 401);
      cookie = (await request('/login', { password: config.password })).headers
        .get('set-cookie')!
        .split(';')[0];
      assert.equal(
        (await request('/terminal/start', { cols: 80, rows: 24 }, 'https://wrong.example')).status,
        403,
      );
      assert.equal((await request('/terminal/start', { cols: 8000, rows: 24 })).status, 400);
      const chat = runtime.store.create('codex', 'example/project', 'Not prepared');
      assert.equal(
        (await request('/terminal/start', { conversationId: chat.id, cols: 80, rows: 24 })).status,
        400,
      );
      const started = await request('/terminal/start', { cols: 80, rows: 24 });
      assert.equal(started.status, 200, JSON.stringify(await started.clone().json()));
      const terminal = (await started.json()) as any;
      assert.equal(
        ((await (await request('/terminal/start', { cols: 80, rows: 24 })).json()) as any).id,
        terminal.id,
      );
      assert.equal(
        (await fetch(config.origin + `/api/terminal/${terminal.id}/events`)).status,
        401,
      );
      const output = await listen(terminal.id);
      const input = async (data: string) =>
        assert.equal((await request(`/terminal/${terminal.id}/input`, { data })).status, 200);
      await input("test -t 0 && test -t 1 && printf '\\nPTY_OK\\n'\r");
      await output.wait('\r\nPTY_OK\r\n');
      await input('read -r answer; printf \'\\nANSWER:%s\\n\' "$answer"\r');
      await input('hello from phone\r');
      await output.wait('\r\nANSWER:hello from phone\r\n');
      await request(`/terminal/${terminal.id}/resize`, { cols: 93, rows: 31 });
      await input("printf '\\nSIZE:'; stty size\r");
      await output.wait('\r\nSIZE:31 93\r\n');
      await input('sleep 60\r');
      await delay(150);
      await input('\u0003');
      await input("printf '\\nINTERRUPTED_OK\\n'\r");
      await output.wait('\r\nINTERRUPTED_OK\r\n');
      const seq = output.seq();
      output.close();
      await input("sleep 0.1; printf '\\nBACKGROUND_OK\\n'\r");
      await delay(250);
      const reconnected = await listen(terminal.id, seq);
      await reconnected.wait('\r\nBACKGROUND_OK\r\n');
      assert.ok(!reconnected.output().includes('\r\nPTY_OK\r\n'));
      const fixture = path.join(dir, 'fixture');
      await mkdir(fixture);
      await writeFile(
        path.join(fixture, 'package.json'),
        JSON.stringify({
          name: 'pa-fixture-cli',
          version: '1.0.0',
          bin: { 'pa-fixture-cli': 'cli.cjs' },
        }),
      );
      await writeFile(
        path.join(fixture, 'cli.cjs'),
        '#!/usr/bin/env node\nconsole.log("PERSISTENT_CLI_OK")\n',
        { mode: 0o755 },
      );
      const quoted = "'" + fixture.replaceAll("'", "'\\''") + "'";
      await input(
        `npm install -g --ignore-scripts --no-audit --no-fund ${quoted} && pa-fixture-cli\r`,
      );
      await reconnected.wait('PERSISTENT_CLI_OK\r\n');
      const cliOutput: string[] = [];
      await runProcess(
        'pa-fixture-cli',
        [],
        dir,
        new AbortController().signal,
        '',
        (line) => cliOutput.push(line),
        agentEnvironment(config),
      );
      assert.deepEqual(cliOutput, ['PERSISTENT_CLI_OK']);
      const env = agentEnvironment(config);
      assert.equal(env.NPM_CONFIG_PREFIX, path.join(dir, 'tools'));
      assert.equal(env.OPENROUTER_API_KEY, undefined);
      assert.equal(env.APP_PASSWORD, undefined);
      // Normal shell jobs terminate when the terminal is explicitly closed.
      await input('sleep 60 & echo $! > "$HOME/child.pid"\r');
      await delay(200);
      const child = Number(await readFile(path.join(dir, 'home/child.pid'), 'utf8'));
      await request(`/terminal/${terminal.id}/stop`, {});
      assert.equal(((await (await request('/terminal')).json()) as any).running, false);
      assert.equal((await request(`/terminal/${terminal.id}/input`, { data: 'x' })).status, 409);
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(child, 0);
        } catch {
          break;
        }
        await delay(20);
      }
      assert.throws(() => process.kill(child, 0));
      restarted = new TerminalService(config);
      const fresh = await restarted.start();
      const old = runtime.terminal.view().id;
      assert.notEqual(fresh.id, old);
      const seen: string[] = [];
      await runProcess(
        'pa-fixture-cli',
        [],
        dir,
        new AbortController().signal,
        '',
        (line) => seen.push(line),
        agentEnvironment(config),
      );
      assert.deepEqual(seen, ['PERSISTENT_CLI_OK']);
      assert.equal(
        runtime.store.db
          .prepare(
            "SELECT count(*) AS n FROM events WHERE data LIKE '%PTY_OK%' OR data LIKE '%sleep 60%'",
          )
          .get()!.n,
        0,
      );
    } finally {
      for (const controller of aborts) controller.abort();
      await restarted?.close();
      await runtime.close();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('terminal does not execute shell commands in demo or restricted mode', async () => {
  const config = readConfig();
  for (const flags of [
    { demo: true, unrestricted: true },
    { demo: false, unrestricted: false },
  ]) {
    const service = new TerminalService({ ...config, ...flags });
    assert.equal(service.view().enabled, false);
    await assert.rejects(service.start(), /ambiente reale/);
    await service.close();
  }
});
