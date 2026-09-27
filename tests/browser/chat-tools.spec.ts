import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

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
    await modal.locator('summary').click();
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
    await inheritSkills.uncheck();
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
    await modal.locator('summary').click();
    await expect(inheritMcp).toBeChecked();
    await expect(inheritSkills).toBeChecked();
    const next = page.waitForResponse(
      (r) => r.url().endsWith('/api/conversations') && r.request().method() === 'POST',
    );
    await modal.getByRole('button', { name: 'Crea chat' }).click();
    const second = await (await next).json();
    chats.push(second.id);
    expect(second.tools).toEqual({ mcp: null, skills: null });
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
