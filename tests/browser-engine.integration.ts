import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { commandFor } from '../server/runner';

test(
  'real Chromium via MCP: navigate, type, click, tabs, dialogs, screenshots, isolation and cleanup',
  { timeout: 90000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pa-browser-engine-'));
    const site = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<!doctype html><html><head><title>Browser fixture</title></head><body><h1>Browser fixture</h1><label>Messaggio<input id="message"></label><button onclick="document.getElementById('result').textContent=document.getElementById('message').value;document.cookie='identity=one';localStorage.setItem('sample','saved')">Salva</button><p id="result">Pronto</p><p id="identity"></p><button onclick="confirm('Confermi?')">Dialogo</button><a href="/next" target="_blank">Nuova pagina</a><select aria-label="Colore"><option value="red">Rosso</option><option value="blue">Blu</option></select><script>document.getElementById('identity').textContent=document.cookie.includes('identity=one')?'one':'guest'</script></body></html>`,
      );
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(site.address() as any).port}/`;
    const config = {
      ...readConfig(),
      dataDir: dir,
      demo: true,
      password: 'browser-fixture-password-24',
      audioKey: '',
      vapidPublic: '',
      vapidPrivate: '',
    };
    let runtime = createApp(config),
      server = runtime.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    config.port = (server.address() as any).port;
    config.origin = `http://127.0.0.1:${config.port}`;
    let cookie = '';
    const request = (endpoint: string, body?: unknown) =>
      fetch(config.origin + '/api' + endpoint, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: cookie,
          Connection: 'close',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const clients: Client[] = [];
    const connect = async (chatId: string, signal: AbortSignal) => {
      const access = runtime.browser.access(chatId, signal);
      const client = new Client({ name: 'browser-fixture-client', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(access.servers[0].url), {
          requestInit: {
            headers: {
              Authorization: `Bearer ${access.env.PA_BROWSER_TOKEN}`,
              Connection: 'close',
            },
          },
        }),
      );
      clients.push(client);
      return { client, access };
    };
    const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
      const result: any = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, result.content?.[0]?.text);
      return result;
    };
    const snapshot = async (client: Client) =>
      JSON.parse((await call(client, 'browser_snapshot')).content[0].text);
    try {
      const login = await request('/login', { password: config.password });
      cookie = login.headers.get('set-cookie')!.split(';')[0];
      const chat = (await (await request('/conversations', { agent: 'claude' })).json()) as any;
      const second = (await (await request('/conversations', { agent: 'codex' })).json()) as any;
      const signal = new AbortController();
      const { client, access } = await connect(chat.id, signal.signal);
      const other = await connect(second.id, new AbortController().signal);
      assert.equal((await request(`/conversations/${chat.id}/browser`)).status, 200);
      assert.equal(
        (await fetch(config.origin + `/api/conversations/${chat.id}/browser`)).status,
        401,
      );
      assert.equal(
        (await fetch(config.origin + '/api/browser/mcp', { method: 'POST' })).status,
        401,
      );
      assert.equal(
        runtime.browser.view(chat.id).status,
        'idle',
        'discovery does not launch Chromium',
      );
      const tools = await client.listTools();
      assert.ok(tools.tools.some((t) => t.name === 'browser_screenshot'));
      for (const agent of ['claude', 'codex'] as const) {
        const command = commandFor(config, { ...chat, agent }, access.servers);
        assert.ok(command.args.join(' ').includes('personal_agent_browser'));
        assert.ok(command.args.join(' ').includes('PA_BROWSER_TOKEN'));
        assert.ok(!command.args.join(' ').includes(access.env.PA_BROWSER_TOKEN!));
      }
      await call(client, 'browser_navigate', { url });
      assert.match((await snapshot(client)).snapshot, /Browser fixture/);
      const beforeFrame = Buffer.from(
        await (await request(`/conversations/${chat.id}/browser/frame`)).arrayBuffer(),
      );
      assert.equal(beforeFrame.readUInt16BE(), 0xffd8);
      await call(client, 'browser_type', {
        role: 'textbox',
        name: 'Messaggio',
        text: 'Compilazione riuscita',
      });
      await call(client, 'browser_click', { role: 'button', name: 'Salva' });
      assert.match((await snapshot(client)).snapshot, /Compilazione riuscita/);
      await call(client, 'browser_select', { role: 'combobox', name: 'Colore', value: 'blue' });
      const shot = await call(client, 'browser_screenshot', { fullPage: true });
      const info = JSON.parse(shot.content[0].text);
      assert.equal(shot.content[1].mimeType, 'image/jpeg');
      const image = await request(`/conversations/${chat.id}/browser/screenshots/${info.id}`);
      assert.equal(image.status, 200);
      assert.match(image.headers.get('content-type')!, /image\/jpeg/);
      assert.equal(
        (await request(`/conversations/${second.id}/browser/screenshots/${info.id}`)).status,
        404,
      );
      assert.equal((await stat(info.path)).mode & 0o777, 0o600);
      assert.match(
        await readFile(path.join(dir, 'browser', chat.id, 'storage.json'), 'utf8'),
        /identity/,
      );
      await call(other.client, 'browser_navigate', { url });
      assert.match((await snapshot(other.client)).snapshot, /guest/);
      await call(client, 'browser_navigate', { url });
      assert.match((await snapshot(client)).snapshot, /one/);
      await call(client, 'browser_click', { role: 'link', name: 'Nuova pagina' });
      await delay(200);
      assert.equal((await snapshot(client)).tabs.length, 2);
      const tabs = (await snapshot(client)).tabs;
      await call(client, 'browser_tabs', {
        action: 'close',
        id: tabs.find((p: any) => p.selected).id,
      });
      assert.equal((await snapshot(client)).tabs.length, 1);
      await call(client, 'browser_click', { role: 'button', name: 'Dialogo' });
      assert.equal((await snapshot(client)).dialog.type, 'confirm');
      await call(client, 'browser_dialog', { accept: false });
      assert.equal((await snapshot(client)).dialog, undefined);
      const blocked: any = await client.callTool({
        name: 'browser_navigate',
        arguments: { url: 'file:///etc/passwd' },
      });
      assert.equal(blocked.isError, true);
      const appBlocked: any = await client.callTool({
        name: 'browser_navigate',
        arguments: { url: config.origin },
      });
      assert.equal(appBlocked.isError, true);
      const events = JSON.stringify(runtime.store.db.prepare('SELECT data FROM events').all());
      assert.ok(!events.includes(access.env.PA_BROWSER_TOKEN!));
      assert.doesNotMatch(events, /Compilazione riuscita/);
      const waiting = client.callTool({ name: 'browser_wait', arguments: { milliseconds: 3000 } });
      await delay(100);
      signal.abort();
      const cancelled: any = await waiting;
      assert.equal(cancelled.isError, true);
      assert.equal(runtime.browser.view(chat.id).tabs.length, 0);
      access.release();
      assert.equal(
        (
          await fetch(config.origin + '/api/browser/mcp', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${access.env.PA_BROWSER_TOKEN}`,
              Connection: 'close',
            },
          })
        ).status,
        401,
      );
      await Promise.allSettled(clients.map((c) => c.close()));
      clients.length = 0;
      await runtime.close();
      await new Promise<void>((r) => server.close(() => r()));
      runtime = createApp(config);
      server = runtime.app.listen(config.port, '127.0.0.1');
      await new Promise<void>((r) => server.once('listening', r));
      assert.equal(runtime.browser.view(chat.id).screenshots.length, 1);
      const resumed = await connect(chat.id, new AbortController().signal);
      await call(resumed.client, 'browser_navigate', { url });
      assert.match((await snapshot(resumed.client)).snapshot, /one/, 'cookies survive restart');
      assert.equal((await request(`/conversations/${chat.id}/delete`, {})).status, 200);
      assert.equal((await request(`/conversations/${chat.id}/browser`)).status, 404);
      await assert.rejects(stat(path.join(dir, 'browser', chat.id)));
    } finally {
      await Promise.allSettled(clients.map((c) => c.close()));
      await runtime.close();
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => site.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
