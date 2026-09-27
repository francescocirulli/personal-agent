import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

test('new chat customizes globally enabled tools without changing other chats', async ({
  page,
  request,
}) => {
  const name = `chat-skill-${Date.now()}`;
  const skill = await (
    await request.post('/api/skills', {
      data: {
        content: `---\nname: ${name}\ndescription: Skill per la chat.\n---\nIstruzioni.`,
        agents: ['codex'],
      },
    })
  ).json();
  const mcp = [
    { id: randomUUID(), name: 'servizio-attivo', enabled: true, status: 'connected' },
    { id: randomUUID(), name: 'servizio-spento', enabled: false, status: 'connected' },
    {
      id: randomUUID(),
      name: 'servizio-da-collegare',
      enabled: true,
      status: 'authorization_required',
    },
  ];
  const chats: string[] = [];
  try {
    await page.route('**/api/mcp', (route) => route.fulfill({ json: mcp }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Inizia una conversazione' }).click();
    const modal = page.getByRole('dialog', { name: 'Nuova chat' });
    await modal.locator('.chat-tools-picker > summary').click();
    const inheritMcp = modal.getByRole('checkbox', {
      name: 'Usa disponibilità globali · MCP',
      exact: true,
    });
    const inheritSkills = modal.getByRole('checkbox', {
      name: 'Usa disponibilità globali · Skill globali',
      exact: true,
    });
    await expect(inheritMcp).toBeChecked();
    await inheritMcp.uncheck();
    await expect(
      modal.getByRole('checkbox', { name: 'servizio-attivo', exact: true }),
    ).toBeChecked();
    await expect(modal.getByRole('checkbox', { name: /servizio-spento/ })).toBeDisabled();
    await expect(modal.getByRole('checkbox', { name: /servizio-da-collegare/ })).toBeDisabled();
    await modal.getByRole('checkbox', { name: 'servizio-attivo', exact: true }).uncheck();
    await modal.getByRole('button', { name: 'Codex', exact: true }).click();
    await expect(inheritSkills).not.toBeChecked();
    await expect(modal.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
    await modal.getByRole('checkbox', { name, exact: true }).check();
    await expect(modal.getByRole('checkbox', { name, exact: true })).toBeChecked();
    await modal.getByRole('button', { name: 'Claude Code', exact: true }).click();
    await expect(modal.getByRole('checkbox', { name: new RegExp(name) })).toBeDisabled();
    await modal.getByRole('button', { name: 'Codex', exact: true }).click();
    await expect(modal.getByRole('checkbox', { name, exact: true })).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/conversations') && r.request().method() === 'POST',
    );
    await modal.getByRole('button', { name: 'Crea chat' }).click();
    const chat = await (await created).json();
    chats.push(chat.id);
    expect(chat.tools).toEqual({ mcp: [], skills: [skill.id] });
    await page.reload();
    expect((await (await request.get(`/api/conversations/${chat.id}`)).json()).tools).toEqual(
      chat.tools,
    );
    await page.getByRole('button', { name: 'Nuova chat', exact: true }).last().click();
    await modal.getByRole('button', { name: 'Codex', exact: true }).click();
    await modal.locator('.chat-tools-picker > summary').click();
    await expect(inheritMcp).toBeChecked();
    await expect(inheritSkills).not.toBeChecked();
    await expect(modal.getByRole('checkbox', { name, exact: true })).not.toBeChecked();
    const next = page.waitForResponse(
      (r) => r.url().endsWith('/api/conversations') && r.request().method() === 'POST',
    );
    await modal.getByRole('button', { name: 'Crea chat' }).click();
    const second = await (await next).json();
    chats.push(second.id);
    expect(second.tools).toEqual({ mcp: null, skills: [] });
    await page.goto('/?settings=skills');
    const settings = page.getByRole('dialog', { name: 'Skill', exact: true });
    await settings.getByRole('checkbox', { name: `Abilita globalmente ${name}` }).click();
    await expect(settings.getByRole('status')).toContainText('Disponibilità globale aggiornata');
    await page.reload();
    await expect(
      settings.getByRole('checkbox', { name: `Abilita globalmente ${name}` }),
    ).not.toBeChecked();
    expect((await (await request.get(`/api/conversations/${chat.id}`)).json()).tools).toEqual(
      chat.tools,
    );
  } finally {
    await request.post(`/api/skills/${skill.id}/delete`, { data: {} });
    for (const id of chats) await request.post(`/api/conversations/${id}/delete`, { data: {} });
  }
});

test('existing chats show effective tools, exclusions and live global changes without leaking other chats', async ({
  page,
  request,
}) => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          serverInfo: { name: 'fixture', version: '1' },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port;
  const suffix = Date.now();
  const chats: string[] = [];
  const skills: string[] = [];
  let connectionId = '';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const connected = await request.post('/api/mcp', {
      data: { name: `notion-${suffix}`, url: `http://127.0.0.1:${port}/mcp` },
    });
    const connection = await connected.json();
    connectionId = connection.id;
    expect(connection.status).toBe('connected');
    const skill = await (
      await request.post('/api/skills', {
        data: {
          content: `---\nname: riepilogo-${suffix}\ndescription: Skill di prova\n---\nIstruzioni`,
          agents: ['codex'],
        },
      })
    ).json();
    skills.push(skill.id);
    const create = async (title: string, tools: unknown) => {
      const chat = await (
        await request.post('/api/conversations', { data: { agent: 'codex', title, tools } })
      ).json();
      chats.push(chat.id);
      return chat;
    };
    const excluded = await create(`Strumenti esclusi ${suffix}`, { mcp: [], skills: [] });
    const included = await create(`Strumenti selezionati ${suffix}`, {
      mcp: [connection.id],
      skills: [skill.id],
    });
    const summaryButton = page.getByRole('button', { name: /^MCP e skill della chat/ });
    const modal = page.getByRole('dialog', { name: 'MCP e skill della chat', exact: true });
    await page.goto(`/?chat=${excluded.id}`);
    await expect(summaryButton).toHaveText('MCP e skill della chat · 0 MCP · 0 skill');
    await expect(page.getByRole('button', { name: /^Collegamenti MCP/ })).toHaveCount(0);
    await expect(page.getByText(/richiede il tuo accesso/)).toHaveCount(0);
    await summaryButton.click();
    await expect(
      modal.getByRole('heading', { name: 'MCP · 0 disponibili', exact: true }),
    ).toBeVisible();
    await modal.locator('summary').first().click();
    await expect(modal.locator('article').filter({ hasText: connection.name })).toContainText(
      'Escluso da questa chat',
    );
    await modal.locator('summary').last().click();
    await expect(modal.locator('article').filter({ hasText: skill.name })).toContainText(
      'Esclusa da questa chat',
    );
    await expect(modal.getByText('Questa chat non ha un repository.')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await modal.getByRole('button', { name: 'Chiudi strumenti della chat' }).click();
    // Switch within the same mounted application, then delay a reply from the old chat.
    await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
    await page
      .getByRole('button', { name: `Strumenti selezionati ${suffix} Codex`, exact: true })
      .click();
    await expect(summaryButton).toHaveText('MCP e skill della chat · 1 MCP · 1 skill');
    await summaryButton.click();
    await expect(modal.locator('article').filter({ hasText: connection.name })).toContainText(
      'Disponibile in questa chat',
    );
    await expect(modal.locator('article').filter({ hasText: skill.name })).toContainText(
      'Disponibile in questa chat',
    );
    // Global disabling updates the open modal via SSE and never changes the saved selection.
    await request.post(`/api/mcp/${connection.id}/enabled`, { data: { enabled: false } });
    await request.post(`/api/skills/${skill.id}/enabled`, { data: { enabled: false } });
    await expect(
      modal.getByRole('heading', { name: 'MCP · 0 disponibili', exact: true }),
    ).toBeVisible();
    await expect(
      modal.getByRole('heading', { name: 'Skill globali · 0 disponibili', exact: true }),
    ).toBeVisible();
    await modal.locator('summary').first().click();
    await expect(modal.locator('article').filter({ hasText: connection.name })).toContainText(
      'Disabilitato globalmente',
    );
    await modal.locator('summary').last().click();
    await expect(modal.locator('article').filter({ hasText: skill.name })).toContainText(
      'Disabilitata globalmente',
    );
    await request.post(`/api/mcp/${connection.id}/enabled`, { data: { enabled: true } });
    await request.post(`/api/skills/${skill.id}/enabled`, { data: { enabled: true } });
    await expect(
      modal.getByRole('heading', { name: 'MCP · 1 disponibili', exact: true }),
    ).toBeVisible();
    await modal.getByRole('button', { name: 'Chiudi strumenti della chat' }).click();
    await expect(summaryButton).toHaveText('MCP e skill della chat · 1 MCP · 1 skill');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await page.route(`**/api/conversations/${included.id}/tools`, async (route) => {
      const result = await route.fetch();
      entered();
      await blocked;
      await route.fulfill({ response: result });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('mcp-change')));
    await started;
    await page.getByRole('button', { name: 'Apri menu', exact: true }).click();
    await page
      .getByRole('button', { name: `Strumenti esclusi ${suffix} Codex`, exact: true })
      .click();
    await expect(summaryButton).toHaveText('MCP e skill della chat · 0 MCP · 0 skill');
    const oldResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/conversations/${included.id}/tools`),
    );
    release();
    await (await oldResponse).finished();
    await expect(summaryButton).toHaveText('MCP e skill della chat · 0 MCP · 0 skill');
    // Failed refresh must not show a global count or a stale count.
    await page.route(`**/api/conversations/${excluded.id}/tools`, (route) =>
      route.fulfill({ status: 503, json: { error: 'Riepilogo non disponibile' } }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('mcp-change')));
    await expect(summaryButton).toContainText('stato non disponibile');
    await summaryButton.click();
    await expect(modal.getByRole('alert')).toContainText('Riepilogo non disponibile');
    await page.unroute(`**/api/conversations/${excluded.id}/tools`);
    await modal.getByRole('button', { name: 'Aggiorna elenco' }).click();
    await expect(
      modal.getByRole('heading', { name: 'MCP · 0 disponibili', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(summaryButton).toHaveText('MCP e skill della chat · 0 MCP · 0 skill');
    expect(errors).toEqual([]);
  } finally {
    for (const id of chats) await request.post(`/api/conversations/${id}/delete`, { data: {} });
    for (const id of skills) await request.post(`/api/skills/${id}/delete`, { data: {} });
    if (connectionId) await request.post(`/api/mcp/${connectionId}/delete`, { data: {} });
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
