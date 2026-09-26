import { test, expect } from '@playwright/test';
import { pcmToWav } from '../../server/audio';
test('skills settings: choose agents, import/edit, project scope, persistence and deletion', async ({
  page,
  request,
}) => {
  const name = `mobile-skill-${Date.now()}`;
  const content = `---\nname: ${name}\ndescription: Skill di prova per il telefono.\n---\nRispondi con una lista breve.\n`;
  const chat = await (
    await request.post('/api/conversations', {
      data: { agent: 'claude', repo: 'example/skills', title: 'Prova skill progetto' },
    })
  ).json();
  let globalId = '';
  try {
    await page.route(`**/api/conversations/${chat.id}/skills`, (r) =>
      r.fulfill({
        json: {
          ready: true,
          warnings: [],
          skills: [
            {
              id: '.claude/skills/repo-skill/SKILL.md',
              name: 'repo-skill',
              description: 'Skill nella repository',
              scope: 'project',
              agents: ['claude', 'codex'],
              path: '.claude/skills/repo-skill/SKILL.md',
            },
          ],
        },
      }),
    );
    await page.route(`**/api/conversations/${chat.id}/skills/file?*`, (r) =>
      r.fulfill({ json: { name: 'repo-skill', content: '# Istruzioni della repo' } }),
    );
    await page.goto('/?settings=skills');
    const modal = page.getByRole('dialog', { name: 'Skill', exact: true });
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Aggiungi skill' }).click();
    await expect(modal.getByRole('button', { name: 'Salva skill' })).toBeDisabled();
    await modal
      .getByLabel('Importa SKILL.md')
      .setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from(content) });
    await expect(modal.getByLabel('Contenuto SKILL.md')).toHaveValue(content);
    await modal.getByRole('checkbox', { name: 'Claude Code', exact: true }).check();
    await modal.getByRole('button', { name: 'Salva skill' }).click();
    await expect(modal.getByRole('status')).toContainText('Skill salvata');
    const globals = await (await request.get('/api/skills')).json();
    const saved = globals.find((s: any) => s.name === name);
    globalId = saved.id;
    expect(saved.agents).toEqual(['claude']);
    await modal.getByRole('button', { name: `Modifica ${name}`, exact: true }).click();
    await modal.getByRole('checkbox', { name: 'Codex', exact: true }).check();
    await modal.getByRole('button', { name: 'Salva skill' }).click();
    await expect(modal.getByRole('status')).toContainText('Skill salvata');
    await page.reload();
    await expect(modal.getByText(name, { exact: true })).toBeVisible();
    expect((await (await request.get('/api/skills/' + globalId)).json()).agents).toEqual([
      'claude',
      'codex',
    ]);
    await modal.getByLabel('Copia del progetto').selectOption(chat.id);
    const project = modal.locator('.skill-card').filter({ hasText: 'repo-skill' });
    await expect(project.getByText('Claude Code · Codex', { exact: true })).toBeVisible();
    await expect(project.getByRole('button', { name: /Modifica|Elimina/ })).toHaveCount(0);
    await project.getByRole('button', { name: 'Leggi repo-skill' }).click();
    await expect(modal.locator('pre')).toContainText('Istruzioni della repo');
    await modal.getByRole('button', { name: 'Chiudi lettura' }).click();
    await modal.evaluate((e) => (e.scrollTop = 0));
    await page.screenshot({ path: 'test-results/settings-skills-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await modal.getByRole('button', { name: `Elimina ${name}`, exact: true }).click();
    await modal.getByRole('button', { name: 'Conferma eliminazione' }).click();
    await expect(modal.getByText(name, { exact: true })).toHaveCount(0);
    await modal.getByRole('button', { name: 'MCP', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Collegamenti MCP' })
      .getByRole('button', { name: 'Skill', exact: true })
      .click();
    await expect(modal).toBeVisible();
  } finally {
    if (globalId) await request.post(`/api/skills/${globalId}/delete`, { data: {} });
    await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
  }
});
test('mobile chat, background task, history, voice view and text fallback', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Tu parli/ })).toBeVisible();
  await page.getByRole('button', { name: 'Inizia una conversazione' }).click();
  await page.getByRole('button', { name: 'Codex', exact: true }).click();
  await page.getByRole('button', { name: 'Crea chat' }).click();
  await expect(page.getByRole('heading', { name: 'Da dove cominciamo?' })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Messaggio', exact: true })
    .fill('Proviamo il lavoro asincrono');
  await page.getByRole('button', { name: 'Invia messaggio' }).click();
  await expect(page.getByText('Puoi cambiare chat. Il lavoro continua.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Questa è una', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ascolta', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Messaggio', exact: true }).fill('Un secondo messaggio');
  await page.getByRole('button', { name: 'Invia messaggio' }).click();
  await expect(page.getByRole('button', { name: 'Ascolta', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Ascolta', exact: true }).first().click();
  await expect(page.getByRole('alert')).toContainText('Voce non configurata');
  await page.getByRole('button', { name: 'Apri modalità voce' }).click();
  await expect(page.getByRole('dialog', { name: 'Modalità voce' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Prepariamo la voce' })).toBeVisible();
  await page.screenshot({ path: 'test-results/voice-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Torna alla chat' }).click();
  await page.screenshot({ path: 'test-results/chat-mobile.png', fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});
test('mobile chat header stays compact and model controls remain accessible', async ({
  page,
  request,
}) => {
  const chat = await (
    await request.post('/api/conversations', { data: { agent: 'codex', repo: null } })
  ).json();
  try {
    await page.goto(`/?chat=${chat.id}`);
    const toolbar = page.locator('.chat-toolbar');
    await expect(toolbar.getByRole('heading', { name: 'Da dove cominciamo?' })).toBeVisible();
    expect((await toolbar.boundingBox())!.height).toBeLessThanOrEqual(95);
    const picker = toolbar.locator('.model-picker');
    await expect(picker.getByLabel('Modello della chat')).toBeHidden();
    await picker.locator('summary').click();
    await picker.getByLabel('Modello della chat').selectOption('gpt-6-sol');
    await expect(picker.locator('summary')).toContainText('GPT-6-Sol');
    await picker.getByLabel('Effort della chat').selectOption('xhigh');
    await expect(picker.locator('summary')).toContainText('xhigh');
    await picker.locator('summary').click();
    await expect(picker.getByLabel('Modello della chat')).toBeHidden();
    await page.setViewportSize({ width: 320, height: 700 });
    await expect(toolbar.getByRole('heading', { name: 'Da dove cominciamo?' })).toBeVisible();
    expect((await toolbar.boundingBox())!.height).toBeLessThanOrEqual(95);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
  }
});
test('desktop welcome and creating a repository chat', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Tu parli/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/welcome-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Inizia una conversazione' }).click();
  await page.getByRole('button', { name: 'Repository GitHub', exact: true }).click();
  await page
    .getByRole('button', { name: 'Inserisci un repository manualmente', exact: true })
    .click();
  await page.getByLabel('Percorso repository').fill('example/project');
  await page.getByRole('button', { name: 'Crea chat' }).click();
  await expect(page.getByText('example/project', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/chat-desktop.png', fullPage: true });
});
test('historical audio pauses, resumes and stops when changing chat', async ({ page }) => {
  let generated = 0;
  await page.route('**/api/config', async (route) => {
    await route.fulfill({
      json: {
        demo: true,
        voiceAvailable: true,
        pushPublicKey: null,
        maxRuns: 3,
        unrestricted: false,
      },
    });
  });
  const pcm = Buffer.alloc(24000 * 2 * 15);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 220) / 24000) * 1000), i * 2);
  await page.route('**/api/conversations/*/messages/*/audio', async (route) => {
    generated++;
    expect(route.request().method()).toBe('GET');
    await route.fulfill({ contentType: 'audio/wav', body: pcmToWav(pcm) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Inizia una conversazione' }).click();
  await page.getByRole('button', { name: 'Crea chat' }).click();
  await page.getByRole('textbox', { name: 'Messaggio', exact: true }).fill('Verifica riascolto');
  await page.getByRole('button', { name: 'Invia messaggio' }).click();
  await page.getByRole('button', { name: 'Ascolta', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pausa', exact: true })).toBeVisible();
  await expect
    .poll(() => page.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime))
    .toBeGreaterThan(0.1);
  expect(
    await page.locator('audio').evaluate((a: HTMLAudioElement) => !a.muted && a.volume > 0),
  ).toBe(true);
  await page.getByRole('button', { name: 'Pausa', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Riprendi', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Riprendi', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pausa', exact: true })).toBeVisible();
  expect(generated).toBe(1);
  await page.getByRole('button', { name: 'Nuova chat', exact: true }).click();
  await page.getByRole('button', { name: 'Crea chat' }).click();
  await expect(page.getByRole('button', { name: 'Pausa', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Da dove cominciamo?' })).toBeVisible();
});
test('dark default and GitHub repository selection', async ({ page }) => {
  await page.route('**/api/github', (route) =>
    route.fulfill({
      json: {
        connected: true,
        login: 'test-account',
        owners: [
          { login: 'test-account', type: 'User' },
          { login: 'test-org', type: 'Organization' },
          { login: 'empty-org', type: 'Organization' },
        ],
        repositories: [
          { fullName: 'test-account/private-app', private: true },
          { fullName: 'test-account/public-app', private: false },
          { fullName: 'test-org/syllo-api', private: true },
          { fullName: 'test-org/syllo-web', private: true },
          { fullName: 'test-org/docs', private: false },
        ],
      },
    }),
  );
  await page.goto('/');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
    'dark',
  );
  await page.getByRole('button', { name: 'Inizia una conversazione' }).click();
  await page.getByRole('button', { name: 'Repository GitHub', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByText('Collegato a test-account', { exact: false }),
  ).toBeVisible();
  const create = page.getByRole('button', { name: 'Crea chat', exact: true });
  await expect(create).toBeDisabled();
  await page.getByLabel('1. Account o organizzazione').selectOption('test-account');
  const options = page.getByRole('list', { name: 'Repository disponibili' });
  await expect(options.getByRole('button')).toHaveCount(2);
  await options.getByRole('button', { name: /private-app/ }).click();
  await expect(create).toBeEnabled();
  await page.getByLabel('1. Account o organizzazione').selectOption('test-org');
  await expect(create).toBeDisabled();
  await page.getByRole('searchbox', { name: 'Cerca repository' }).fill('SYL');
  await expect(options.getByRole('button')).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Cerca repository' }).fill('missing');
  await expect(page.getByText('Nessun repository corrisponde alla ricerca.')).toBeVisible();
  await page.getByLabel('1. Account o organizzazione').selectOption('empty-org');
  await expect(page.getByText('Nessun repository accessibile per questo account.')).toBeVisible();
  await page.getByLabel('1. Account o organizzazione').selectOption('test-org');
  await page.getByRole('searchbox', { name: 'Cerca repository' }).fill('web');
  await expect(options.getByRole('button')).toHaveCount(1);
  await page.screenshot({
    path: 'test-results/repository-picker-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await options.getByRole('button', { name: /syllo-web/ }).click();
  await expect(page.getByText('syllo-web', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await page.getByRole('button', { name: 'Crea chat' }).click();
  await expect(page.getByRole('heading', { name: 'Da dove cominciamo?' })).toBeVisible();
  const id = new URL(page.url()).searchParams.get('chat');
  const chat = await (await page.request.get(`/api/conversations/${id}`)).json();
  expect(chat.repo).toBe('test-org/syllo-web');
});

test('project groups, renaming, deletion and synchronization across windows', async ({
  page,
  context,
}) => {
  const suffix = Date.now().toString();
  const repo = `test/group-${suffix}`;
  const create = async (title: string, project: string | null) => {
    const response = await page.request.post('/api/conversations', {
      data: { agent: 'codex', title, repo: project },
    });
    return response.json();
  };
  const a = await create(`Chat A ${suffix}`, repo);
  await create(`Chat B ${suffix}`, repo);
  const free = await create(`Libera ${suffix}`, null);
  await page.goto(`/?chat=${a.id}`);
  await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
  const group = page.getByRole('region', { name: repo, exact: true });
  await expect(group.locator('.chat-row')).toHaveCount(2);
  await expect(
    page
      .getByRole('region', { name: 'Chat libere', exact: true })
      .getByRole('button', { name: `Menu chat: ${free.title}`, exact: true }),
  ).toBeVisible();
  await group.getByRole('button', { name: `Menu chat: ${a.title}`, exact: true }).click();
  await page.getByRole('button', { name: 'Rinomina', exact: true }).click();
  const title = `Lavoro rinominato ${suffix}`;
  await page.getByLabel('Titolo della chat').fill(title);
  await page.getByRole('button', { name: 'Salva titolo', exact: true }).click();
  await expect(
    group.getByRole('button', { name: `Menu chat: ${title}`, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto(`/?chat=${a.id}`);
  await expect(other.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.bringToFront();
  await page.getByRole('button', { name: 'Menu della chat', exact: true }).click();
  await page.getByRole('button', { name: 'Elimina', exact: true }).click();
  await page.getByRole('button', { name: 'Annulla', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Menu della chat', exact: true }).click();
  await page.getByRole('button', { name: 'Elimina', exact: true }).click();
  await page.getByRole('button', { name: 'Elimina chat', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Tu parli/ })).toBeVisible();
  await expect(other.getByRole('heading', { name: /Tu parli/ })).toBeVisible();
  await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
  await expect(group.locator('.chat-row')).toHaveCount(1);
  await expect(group.getByRole('button', { name: `Menu chat: ${title}`, exact: true })).toHaveCount(
    0,
  );
  await expect(
    group.getByRole('button', { name: `Menu chat: Chat B ${suffix}`, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: 'test-results/project-groups-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await other.close();
});

test('voice settings save, survive reload and can restore defaults', async ({ page }) => {
  await page.goto('/');
  const open = async () => {
    await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
    await page.getByRole('button', { name: 'Impostazioni', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Impostazioni voce' })).toBeVisible();
  };
  await open();
  await expect(page.getByLabel('Modello della voce')).toBeVisible();
  await page.getByLabel('Voce', { exact: true }).fill('Puck');
  await page.getByRole('button', { name: 'Salva impostazioni', exact: true }).click();
  await expect(page.getByText(/Impostazioni voce salvate/)).toBeVisible();
  await page.reload();
  await open();
  await expect(page.getByLabel('Voce', { exact: true })).toHaveValue('Puck');
  await page.screenshot({ path: 'test-results/settings-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await page.getByRole('button', { name: 'Ripristina predefiniti', exact: true }).click();
  await expect(page.getByLabel('Voce', { exact: true })).toHaveValue('Kore');
  await page.getByRole('button', { name: 'Salva impostazioni', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('microphone mute survives permission, discards noise and stays muted through a spoken reply', async ({
  page,
}) => {
  let audioUploads = 0;
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        demo: true,
        voiceAvailable: true,
        pushPublicKey: null,
        maxRuns: 3,
        unrestricted: false,
      },
    }),
  );
  await page.route('**/api/conversations/*/turns', async (route) => {
    if (route.request().headers()['content-type']?.includes('multipart')) {
      audioUploads++;
      await route.fulfill({ status: 503, json: { error: 'Audio simulato per il test.' } });
    } else await route.continue();
  });
  await page.route('**/api/conversations/*/messages/*/audio', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: pcmToWav(Buffer.alloc(4800)) }),
  );
  await page.addInitScript(() => {
    // Deterministic microphone input: no device permission or physical recording.
    const w = window as any;
    const track = {
      enabled: true,
      stop() {
        this.enabled = false;
      },
      onended: null,
    };
    w.micTest = { track, loud: false, recordings: 0, stops: 0, plays: 0 };
    document.addEventListener('playing', () => w.micTest.plays++, true);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: () =>
          new Promise((resolve) => {
            w.micTest.grant = () =>
              resolve({ getTracks: () => [track], getAudioTracks: () => [track] });
          }),
      },
    });
    w.AudioContext = class {
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return {
          fftSize: 1024,
          getFloatTimeDomainData(samples: Float32Array) {
            samples.fill(w.micTest.loud && track.enabled ? 0.2 : 0);
          },
        };
      }
    };
    w.MediaRecorder = class {
      static isTypeSupported() {
        return true;
      }
      state = 'inactive';
      mimeType = 'audio/mp4';
      ondataavailable?: (event: any) => void;
      onstop?: () => void;
      start() {
        this.state = 'recording';
        w.micTest.recordings++;
      }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob(['simulated speech']) });
          this.onstop?.();
          w.micTest.stops++;
        });
      }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Inizia una conversazione' }).click();
  await page.getByRole('button', { name: 'Crea chat' }).click();
  await page.getByRole('button', { name: 'Apri modalità voce' }).click();
  const voice = page.getByRole('dialog', { name: 'Modalità voce' });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).micTest.grant))
    .toBe('function');
  await voice.getByRole('button', { name: 'Disattiva microfono', exact: true }).click();
  await page.evaluate(() => (window as any).micTest.grant());
  const unmute = voice.getByRole('button', { name: 'Riattiva microfono', exact: true });
  await expect(unmute).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => (window as any).micTest.track.enabled)).toBe(false);
  await page.evaluate(() => {
    (window as any).micTest.loud = true;
  });
  await unmute.click();
  await expect.poll(() => page.evaluate(() => (window as any).micTest.recordings)).toBe(1);
  await voice.getByRole('button', { name: 'Disattiva microfono', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).micTest.stops)).toBe(1);
  expect(audioUploads).toBe(0);
  await page.evaluate(() => {
    (window as any).micTest.loud = false;
  });
  const id = new URL(page.url()).searchParams.get('chat');
  await page.request.post(`/api/conversations/${id}/turns`, {
    data: { text: 'Risposta mentre il microfono è muto' },
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).micTest.plays))
    .toBeGreaterThanOrEqual(2);
  await expect(voice.getByRole('heading', { name: 'Microfono disattivato' })).toBeVisible();
  await expect(unmute).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as any).micTest.track.enabled)).toBe(false);
  expect(audioUploads).toBe(0);
  await page.screenshot({ path: 'test-results/microphone-muted-mobile.png', fullPage: true });
  await unmute.click();
  await expect.poll(() => page.evaluate(() => (window as any).micTest.track.enabled)).toBe(true);
  await expect(voice.getByRole('status')).toContainText('Microfono attivo');
  await page.evaluate(() => {
    (window as any).micTest.loud = true;
  });
  await expect.poll(() => page.evaluate(() => (window as any).micTest.recordings)).toBe(2);
  await page.evaluate(() => {
    (window as any).micTest.loud = false;
  });
  await expect.poll(() => audioUploads).toBe(1);
  await voice.getByRole('button', { name: 'Torna alla chat' }).click();
  expect(await page.evaluate(() => (window as any).micTest.track.enabled)).toBe(false);
});

test('MCP on mobile: login link, automatic completion and manual return stay outside messages', async ({
  page,
}) => {
  let entries: any[] = [];
  let postedReturn = '';
  await page.route('**/api/mcp**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: entries });
    const body = request.postDataJSON();
    if (pathname.endsWith('/mcp')) {
      entries = [
        {
          id: 'test-connection',
          name: body.name,
          url: body.url,
          mode: 'automatic',
          status: 'authorization_required',
          authorizationUrl: 'https://oauth.example.test/authorize?state=test-only',
        },
      ];
    } else if (pathname.endsWith('/login')) {
      entries[0] = {
        ...entries[0],
        mode: body.mode,
        status: 'authorization_required',
        error: undefined,
        authorizationUrl: 'https://oauth.example.test/authorize?state=manual-test',
      };
    } else if (pathname.endsWith('/complete')) {
      postedReturn = body.url;
      entries[0] = { ...entries[0], status: 'connected', authorizationUrl: undefined };
    } else if (pathname.endsWith('/delete')) entries = [];
    return route.fulfill({ json: entries[0] || { ok: true } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Inizia una conversazione' }).click();
  await page.getByRole('button', { name: 'Crea chat' }).click();
  await page.getByRole('button', { name: 'Collegamenti MCP', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Collegamenti MCP' });
  await dialog.getByLabel('Nome del collegamento').fill('notion');
  await dialog.getByLabel('Indirizzo del server MCP').fill('https://mcp.example.test/mcp');
  await dialog.getByRole('button', { name: 'Collega servizio', exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Accedi al servizio notion' })).toHaveAttribute(
    'target',
    '_blank',
  );
  await page.getByRole('button', { name: 'Chiudi collegamenti MCP' }).click();
  await expect(page.getByText('richiede il tuo accesso.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Accedi al servizio notion' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  // Completing OAuth in the external browser updates the open PWA via SSE/focus.
  entries[0] = { ...entries[0], status: 'connected', authorizationUrl: undefined };
  await page.evaluate(() => window.dispatchEvent(new Event('mcp-change')));
  await expect(page.getByRole('button', { name: 'Collegamenti MCP · 1 collegati' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Accedi al servizio notion' })).toHaveCount(0);
  entries[0] = {
    ...entries[0],
    status: 'error',
    error: 'Il servizio rifiuta il ritorno automatico.',
  };
  await page.evaluate(() => window.dispatchEvent(new Event('mcp-change')));
  await page.getByRole('button', { name: 'Collegamenti MCP', exact: true }).click();
  await dialog.getByText('Usa copia e incolla', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Avvia login manuale', exact: true }).click();
  const callback = 'http://localhost:4319/callback?code=private-test-code&state=manual-test';
  await dialog.getByLabel('Indirizzo dopo il login').fill(callback);
  await page.screenshot({ path: 'test-results/mcp-manual-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Completa collegamento', exact: true }).click();
  await expect(
    dialog.getByText('Collegato · tutte le chat, dal prossimo messaggio.'),
  ).toBeVisible();
  expect(postedReturn).toBe(callback);
  await expect(dialog.getByLabel('Indirizzo dopo il login')).toHaveCount(0);
  await page.getByRole('button', { name: 'Chiudi collegamenti MCP' }).click();
  await expect(page.locator('.messages')).not.toContainText('private-test-code');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.reload();
  await page.getByRole('button', { name: 'Collegamenti MCP · 1 collegati' }).click();
  await dialog.getByRole('button', { name: 'Scollega notion' }).click();
  await dialog.getByRole('button', { name: 'Scollega da tutte le chat', exact: true }).click();
  await expect(dialog.getByText('Collegato · tutte le chat, dal prossimo messaggio.')).toHaveCount(
    0,
  );
});

test('settings MCP manages shared connections without a chat and syncs other windows', async ({
  page,
  context,
}) => {
  let entries: any[] = [
    {
      id: 'global-test',
      name: 'calendar',
      url: 'https://example.test/mcp',
      status: 'connected',
      mode: 'automatic',
    },
  ];
  await context.route('**/api/mcp**', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: entries });
    if (new URL(route.request().url()).pathname.endsWith('/delete')) entries = [];
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
  await page.getByRole('button', { name: 'Impostazioni', exact: true }).click();
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Collegamenti MCP' });
  await expect(dialog.getByText(/condivisi da tutte le chat/)).toBeVisible();
  await expect(dialog.getByText('calendar', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Voce', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Impostazioni voce' })).toBeVisible();
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  const second = await context.newPage();
  await second.goto('/?settings=mcp');
  const secondDialog = second.getByRole('dialog', { name: 'Collegamenti MCP' });
  await expect(secondDialog.getByText('calendar', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Scollega calendar' }).click();
  await expect(dialog.getByText(/Scollegare calendar da tutte le chat/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Annulla', exact: true }).click();
  await expect(dialog.getByText('calendar', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Scollega calendar' }).click();
  await dialog.getByRole('button', { name: 'Scollega da tutte le chat', exact: true }).click();
  await expect(dialog.getByText(/Nessun servizio collegato/)).toBeVisible();
  await second.evaluate(() => window.dispatchEvent(new Event('mcp-change')));
  await expect(secondDialog.getByText(/Nessun servizio collegato/)).toBeVisible();
  await page.screenshot({ path: 'test-results/settings-mcp-mobile.png', fullPage: true });
  await second.close();
});

test('mobile browser viewer follows the page, shows screenshots and stops frames when closed', async ({
  page,
}) => {
  let frameRequests = 0;
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
    'base64',
  );
  let state: any = {
    status: 'idle',
    action: 'L’agente non ha ancora aperto il browser.',
    url: '',
    title: '',
    updatedAt: 0,
    tabs: [],
    screenshots: [],
  };
  await page.route('**/api/conversations/*/browser**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/frame')) {
      frameRequests++;
      return route.fulfill({ contentType: 'image/png', body: image });
    }
    if (pathname.includes('/screenshots/'))
      return route.fulfill({ contentType: 'image/png', body: image });
    return route.fulfill({ json: state });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Inizia una conversazione' }).click();
  await page.getByRole('button', { name: 'Crea chat' }).click();
  await page.getByRole('button', { name: 'Apri browser della chat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Browser della chat' });
  await expect(dialog.getByText(/Chiedi all’agente di aprire un sito/)).toBeVisible();
  expect(frameRequests).toBe(0);
  state = {
    ...state,
    status: 'working',
    action: 'Compilo un campo.',
    url: 'https://example.test/form',
    title: 'Pagina di prova',
    tabs: [{ id: 'tab', url: 'https://example.test/form', selected: true }],
  };
  await page.evaluate(() => window.dispatchEvent(new Event('browser-change')));
  await expect(dialog.getByAltText('Vista attuale del browser dell’agente')).toBeVisible();
  await expect
    .poll(() =>
      dialog
        .getByAltText('Vista attuale del browser dell’agente')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(dialog.getByRole('status')).toHaveText('Compilo un campo.');
  await expect.poll(() => frameRequests).toBeGreaterThan(1);
  await dialog.getByRole('button', { name: 'Ingrandisci', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await dialog.getByRole('button', { name: 'Adatta', exact: true }).click();
  state = {
    ...state,
    status: 'ready',
    screenshots: [{ id: 'saved-shot', url: state.url, title: state.title, createdAt: Date.now() }],
  };
  await page.evaluate(() => window.dispatchEvent(new Event('browser-change')));
  await dialog.getByRole('button', { name: /Apri screenshot/ }).click();
  await expect(dialog.getByAltText('Screenshot salvato della pagina')).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Scarica' })).toHaveAttribute(
    'download',
    'screenshot-saved-shot.jpg',
  );
  await page.screenshot({ path: 'test-results/browser-viewer-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Vista attuale' }).click();
  await expect(dialog.getByAltText('Vista attuale del browser dell’agente')).toBeVisible();
  await dialog.getByRole('button', { name: 'Chiudi browser' }).click();
  await expect(dialog).toHaveCount(0);
  const stoppedAt = frameRequests;
  await page.waitForTimeout(1500);
  expect(frameRequests).toBe(stoppedAt);
});

test('terminal settings: mobile input, controls, reconnect and explicit stop', async ({ page }) => {
  const id = 'terminal-ui-fixture';
  let starts = 0,
    stops = 0;
  const inputs: string[] = [];
  let state = {
    enabled: true,
    id: null as string | null,
    running: false,
    cwd: '/data/home',
    home: '/data/home',
    toolsPrefix: '/data/tools',
  };
  await page.addInitScript(() => {
    const Native = window.EventSource;
    (window as any).EventSource = class {
      onopen: any;
      onmessage: any;
      onerror: any;
      timer: any;
      constructor(url: string, options?: EventSourceInit) {
        if (!url.includes('/api/terminal/')) return new Native(url, options) as any;
        this.timer = setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({
            data: JSON.stringify({
              seq: 1,
              type: 'data',
              data: 'Terminale di prova\r\nnode@agent:~$ ',
            }),
          });
        }, 30);
      }
      addEventListener() {}
      close() {
        clearTimeout(this.timer);
      }
    };
  });
  await page.route('**/api/terminal', (r) => r.fulfill({ json: state }));
  await page.route('**/api/terminal/start', (r) => {
    starts++;
    state = { ...state, id, running: true };
    return r.fulfill({ json: state });
  });
  await page.route(`**/api/terminal/${id}/input`, (r) => {
    inputs.push(r.request().postDataJSON().data);
    return r.fulfill({ json: { ok: true } });
  });
  await page.route(`**/api/terminal/${id}/resize`, (r) => r.fulfill({ json: { ok: true } }));
  await page.route(`**/api/terminal/${id}/stop`, (r) => {
    stops++;
    state = { ...state, running: false };
    return r.fulfill({ json: state });
  });
  await page.goto('/?settings=terminal');
  const dialog = page.getByRole('dialog', { name: 'Terminale', exact: true });
  await expect(dialog.getByText('Pronto ad avviare')).toBeVisible();
  expect(starts).toBe(0);
  await dialog.getByRole('button', { name: 'Avvia terminale' }).click();
  await expect(dialog.getByLabel('Comando o risposta')).toBeEnabled();
  await dialog.getByLabel('Comando o risposta').fill('echo hello');
  await dialog.getByRole('button', { name: 'Invia', exact: true }).click();
  await expect.poll(() => inputs.includes('echo hello\r')).toBe(true);
  await expect(dialog.getByLabel('Comando o risposta')).toHaveValue('');
  await dialog.getByRole('button', { name: 'Ctrl+C', exact: true }).click();
  await dialog.getByRole('button', { name: 'Tab', exact: true }).click();
  await expect.poll(() => inputs.join('')).toContain('\u0003\t');
  await dialog.getByLabel('Nascondi il testo che scrivi').check();
  await expect(dialog.getByLabel('Comando o risposta')).toHaveAttribute('type', 'password');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `test-results/terminal-${test.info().project.name}.png`,
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'Voce', exact: true }).click();
  expect(stops).toBe(0);
  await page.getByRole('button', { name: 'Terminale', exact: true }).click();
  await expect(dialog.getByLabel('Comando o risposta')).toBeEnabled();
  expect(starts).toBe(1);
  await dialog.getByRole('button', { name: 'Termina sessione', exact: true }).click();
  expect(stops).toBe(0);
  await dialog.getByRole('button', { name: 'Conferma chiusura' }).click();
  await expect(dialog.getByText('Sessione terminata', { exact: false }).first()).toBeVisible();
  expect(stops).toBe(1);
});

test('model and effort pickers persist selection for both agents', async ({ page, request }) => {
  for (const agent of ['claude', 'codex']) {
    const chat = await (
      await request.post('/api/conversations', { data: { agent, title: 'Scelta modello' } })
    ).json();
    try {
      await page.goto(`/?chat=${chat.id}`);
      await page.locator('.model-picker > summary').click();
      await expect(page.getByLabel('Effort della chat')).toHaveValue('high');
      await page.getByLabel('Effort della chat').selectOption('low');
      await expect(page.getByLabel('Effort della chat')).toBeEnabled();
      await page.getByLabel('Modello della chat').selectOption('__custom');
      await page.getByLabel('ID modello', { exact: true }).fill('test-model');
      await page.getByRole('button', { name: 'Salva modello' }).click();
      await expect(page.getByLabel('Modello della chat')).toHaveValue('test-model');
      await page.reload();
      await page.locator('.model-picker > summary').click();
      await expect(page.getByLabel('Effort della chat')).toHaveValue('low');
      expect((await (await request.get(`/api/conversations/${chat.id}`)).json()).effort).toBe(
        'low',
      );
      await expect(page.getByLabel('Modello della chat')).toHaveValue('test-model');
      expect((await (await request.get(`/api/conversations/${chat.id}`)).json()).model).toBe(
        'test-model',
      );
      await page.getByLabel('Modello della chat').selectOption('');
      await expect(page.getByLabel('Modello della chat')).toHaveValue('');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    } finally {
      await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
    }
  }
});

test('terminal browser opens from CLI request and supports touch, private text, tabs and closing without stopping shell', async ({
  page,
}) => {
  const tab = '96bdfd69-1e8c-49fb-8396-92227cf52df7';
  const inputs: any[] = [];
  let browserRequestId = 0;
  const state = {
    status: 'ready',
    action: 'Pronto',
    url: 'https://example.test/login',
    title: 'Login',
    updatedAt: 1,
    tabs: [{ id: tab, url: 'https://example.test/login', selected: true }],
    screenshots: [],
  };
  await page.route('**/api/terminal', (r) =>
    r.fulfill({
      json: {
        enabled: true,
        running: false,
        id: null,
        home: '/data/home',
        cwd: '/data/home',
        toolsPrefix: '/data/tools',
        browserRequestId,
      },
    }),
  );
  await page.route('**/api/terminal/browser', (r) => r.fulfill({ json: state }));
  await page.route('**/api/terminal/browser/frame', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="white"/><text x="100" y="100">Login</text></svg>',
    }),
  );
  await page.route('**/api/terminal/browser/input', (r) => {
    inputs.push(r.request().postDataJSON());
    return r.fulfill({ json: state });
  });
  await page.goto('/?settings=terminal');
  await expect(
    page.getByRole('button', { name: 'Browser del terminale', exact: true }),
  ).toBeVisible();
  browserRequestId++;
  const dialog = page.getByRole('dialog', { name: 'Browser del terminale', exact: true });
  await expect(dialog).toBeVisible();
  const screen = dialog.getByRole('button', { name: 'Pagina interattiva del browser' });
  await expect(screen).toBeEnabled();
  await screen.click();
  await expect
    .poll(() => inputs.some((i) => i.type === 'click' && i.x >= 0 && i.x <= 1280 && i.tab === tab))
    .toBe(true);
  await dialog.getByLabel('Testo per il campo selezionato').fill('private fixture');
  await expect(dialog.getByLabel('Testo per il campo selezionato')).toHaveAttribute(
    'type',
    'password',
  );
  await dialog.getByRole('button', { name: 'Invia testo al browser' }).click();
  await expect
    .poll(() => inputs.some((i) => i.type === 'text' && i.text === 'private fixture'))
    .toBe(true);
  await expect(dialog.getByLabel('Testo per il campo selezionato')).toHaveValue('');
  await dialog.getByRole('button', { name: 'Enter', exact: true }).click();
  await dialog.getByRole('button', { name: 'Scorri giù' }).click();
  await dialog.getByRole('button', { name: 'Ingrandisci pagina' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Chiudi browser del terminale' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Terminale', exact: true })).toBeVisible();
});

test('chat images: attachment picker, paste, remove, failed upload retry and history on both agents', async ({
  page,
  request,
}) => {
  const { default: sharp } = await import('sharp');
  const png = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#3799ee' },
  })
    .png()
    .toBuffer();
  for (const agent of ['claude', 'codex']) {
    const chat = await (
      await request.post('/api/conversations', { data: { agent, title: `Immagini ${agent}` } })
    ).json();
    try {
      await page.goto(`/?chat=${chat.id}`);
      await expect(page.getByRole('button', { name: 'Allega immagini' })).toBeVisible();
      const picker = page.getByLabel('Seleziona immagini');
      await picker.setInputFiles({ name: 'selezionata.png', mimeType: 'image/png', buffer: png });
      await expect(
        page.getByLabel('Immagini da inviare').getByAltText('selezionata.png'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Rimuovi immagine 1' }).click();
      await expect(
        page.getByRole('button', { name: 'Invia messaggio', exact: true }),
      ).toBeDisabled();
      await page.getByLabel('Messaggio', { exact: true }).evaluate((element, bytes) => {
        const clipboardData = new DataTransfer();
        clipboardData.items.add(
          new File([new Uint8Array(bytes)], 'incollata.png', { type: 'image/png' }),
        );
        element.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
        );
      }, Array.from(png));
      await expect(
        page.getByLabel('Immagini da inviare').getByAltText('incollata.png'),
      ).toBeVisible();
      await picker.setInputFiles({ name: 'seconda.png', mimeType: 'image/png', buffer: png });
      await page.route(
        `**/api/conversations/${chat.id}/turns`,
        (route) => route.fulfill({ status: 503, json: { error: 'Errore upload di prova' } }),
        { times: 1 },
      );
      await page.getByRole('button', { name: 'Invia messaggio', exact: true }).click();
      await expect(page.getByText('Errore upload di prova', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Immagini da inviare').locator('img')).toHaveCount(2);
      await page.getByRole('button', { name: 'Invia messaggio', exact: true }).click();
      await expect(page.getByLabel('Immagini da inviare')).toHaveCount(0);
      await expect(page.locator('.message.user img')).toHaveCount(2);
      await expect(page.getByRole('button', { name: 'Allega immagini' })).toBeEnabled();
      await page.reload();
      await expect(page.locator('.message.user img')).toHaveCount(2);
      await expect
        .poll(() =>
          page
            .locator('.message.user img')
            .evaluateAll((images) =>
              images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
            ),
        )
        .toBe(true);
      const detail = await (await request.get(`/api/conversations/${chat.id}`)).json();
      expect(detail.messages[0].text).toBe('Descrivi le immagini allegate.');
      expect(detail.messages[0].attachments).toHaveLength(2);
      await picker.setInputFiles({
        name: 'invalid.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg/>'),
      });
      await expect(
        page.getByText('Usa PNG, JPEG, WebP o GIF, massimo 5 MB per immagine.'),
      ).toBeVisible();
      await expect(page.getByLabel('Immagini da inviare')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    } finally {
      await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
    }
  }
});
