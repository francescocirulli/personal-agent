import { test, expect } from '@playwright/test';

const content = `---\nname: documento\ndescription: Prova Markdown\n---\n# Piano di lavoro\n\nIntroduzione con **testo importante** e [Vai ai dettagli](#dettagli).\n\n| Attività | Stato | Responsabile | Note |\n| --- | --- | --- | --- |\n| Ricerca | Pronta | Francesca | Un testo lungo dentro la tabella |\n\n- [x] Preparare il piano\n- [ ] Verificare i dettagli\n\n\`\`\`ts\nconst saluto = 'ciao';\n// # Non è un titolo\n\`\`\`\n\n<script>window.markdownExecuted = true</script>\n[pericoloso](javascript:alert(1))\n![Immagine esterna](https://example.com/tracker.png)\n\n${Array.from({ length: 35 }, (_, i) => `## Sezione ${i}\n\nParagrafo ${i} con informazioni da consultare sul telefono.\n`).join('\n')}\n## Dettagli\n\nObiettivo finale da ricordare.\n`;

async function upload(request: any, agent = 'codex') {
  const chat = await (
    await request.post('/api/conversations', { data: { agent, title: 'Lettura Markdown' } })
  ).json();
  await request.post(`/api/conversations/${chat.id}/turns`, {
    multipart: {
      text: 'Leggi il documento',
      files: { name: 'piano.MD', mimeType: 'text/markdown', buffer: Buffer.from(content) },
    },
  });
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/conversations/${chat.id}`)).json()).runs.at(-1)?.status,
    )
    .toBe('complete');
  return chat;
}

test('mobile Markdown reader: rendering, search, index, source, copy, share, download and reading position', async ({
  page,
  request,
}) => {
  const chat = await upload(request);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).copiedText = text;
        },
      },
    });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: ShareData) => {
        (window as any).sharedText = await data.files![0].text();
      },
    });
  });
  const remoteRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('example.com')) remoteRequests.push(req.url());
  });
  try {
    await page.goto(`/?chat=${chat.id}`);
    const card = page.locator('.file-card').filter({ hasText: 'piano.MD' });
    await card.getByRole('button', { name: 'Apri', exact: true }).click();
    const reader = page.getByRole('dialog', { name: 'Documento: piano.MD' });
    await expect(
      reader.getByRole('heading', { name: 'Piano di lavoro', exact: true }),
    ).toBeVisible();
    await expect(reader.locator('.md-table table')).toHaveCount(1);
    await expect(reader.locator('.md-content input[type=checkbox]')).toHaveCount(2);
    await expect(reader.locator('.md-content input[type=checkbox]').first()).toBeChecked();
    expect(await page.locator('#root').evaluate((el) => (el as HTMLElement).inert)).toBe(true);
    expect(await reader.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => (window as any).markdownExecuted)).toBeUndefined();
    expect(remoteRequests).toEqual([]);
    await expect(reader.locator('a[href^="javascript:"]')).toHaveCount(0);
    await reader.getByRole('link', { name: 'Vai ai dettagli' }).click();
    await expect(reader.getByRole('heading', { name: 'Dettagli', exact: true })).toBeInViewport();
    await reader.getByRole('button', { name: 'Copia codice' }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).copiedText))
      .toBe("const saluto = 'ciao';\n// # Non è un titolo\n");
    await reader.getByRole('button', { name: 'Indice', exact: true }).click();
    const index = reader.getByRole('navigation', { name: 'Indice documento' });
    await expect(index.getByRole('button', { name: /Non è un titolo/ })).toHaveCount(0);
    await index.getByRole('button', { name: 'Dettagli', exact: true }).click();
    await expect(reader.getByRole('heading', { name: 'Dettagli', exact: true })).toBeInViewport();
    await reader.getByRole('button', { name: 'Ingrandisci testo' }).click();
    const font = await reader
      .locator('.md-content')
      .evaluate((el) => getComputedStyle(el).fontSize);
    expect(Number.parseFloat(font)).toBeGreaterThan(18);
    await reader.getByRole('searchbox', { name: 'Cerca nel documento' }).fill('Paragrafo');
    await expect(reader.locator('.md-search [role=status]')).toHaveText('1/35');
    await reader.getByRole('button', { name: 'Risultato successivo' }).click();
    await expect(reader.locator('.md-search [role=status]')).toHaveText('2/35');
    await reader.getByRole('searchbox', { name: 'Cerca nel documento' }).fill('');
    await reader.locator('.md-scroll').evaluate((el) => {
      el.scrollTop = 1200;
    });
    await expect.poll(() => reader.locator('.md-scroll').evaluate((el) => el.scrollTop)).toBe(1200);
    await reader.getByRole('button', { name: 'Chiudi lettura' }).click();
    expect(await page.locator('#root').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
    await card.getByRole('button', { name: 'Apri', exact: true }).click();
    await expect(
      reader.getByRole('heading', { name: 'Piano di lavoro', exact: true }),
    ).toBeAttached();
    await expect.poll(() => reader.locator('.md-scroll').evaluate((el) => el.scrollTop)).toBe(1200);
    await reader.getByRole('button', { name: 'Sorgente', exact: true }).click();
    await expect(reader.locator('.md-source')).toHaveText(content);
    await reader.getByRole('button', { name: 'Copia sorgente' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).copiedText)).toBe(content);
    await reader.getByRole('button', { name: 'Condividi', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).sharedText)).toBe(content);
    const downloading = page.waitForEvent('download');
    await reader.getByRole('link', { name: 'Scarica', exact: true }).click();
    expect((await downloading).suggestedFilename()).toBe('piano.MD');
    await reader.getByRole('button', { name: 'Leggi', exact: true }).click();
    await expect.poll(() => reader.locator('.md-scroll').evaluate((el) => el.scrollTop)).toBe(1200);
    await reader.locator('.md-scroll').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: 'test-results/markdown-reader-mobile.png', fullPage: true });
    await page.keyboard.press('Escape');
    await expect(reader).toBeHidden();
  } finally {
    await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
  }
});

test('asking about an attachment keeps the existing draft and references the exact file without sending', async ({
  page,
  request,
}) => {
  const chat = await upload(request, 'claude');
  try {
    await page.goto(`/?chat=${chat.id}`);
    const composer = page.getByRole('textbox', { name: 'Messaggio', exact: true });
    await composer.fill('Vorrei aggiornare la conclusione.');
    const detail = await (await request.get(`/api/conversations/${chat.id}`)).json();
    const file = detail.messages.find((m: any) => m.role === 'user').attachments[0];
    // The same reader also handles files returned in assistant messages.
    await page.route(`**/api/conversations/${chat.id}`, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.messages.find((m: any) => m.role === 'assistant').attachments = [file];
      await route.fulfill({ json: data });
    });
    await page.reload();
    await page
      .locator('.message.assistant .file-card')
      .getByRole('button', { name: 'Apri', exact: true })
      .click();
    const reader = page.getByRole('dialog', { name: 'Documento: piano.MD' });
    await reader.getByRole('button', { name: 'Chiedi su questo file' }).click();
    await expect(reader).toBeHidden();
    await expect(composer).toHaveValue(
      new RegExp(`Vorrei aggiornare la conclusione\\.[\\s\\S]*${file.id}`),
    );
    expect(
      (await (await request.get(`/api/conversations/${chat.id}`)).json()).messages.length,
    ).toBe(detail.messages.length);
    await page.reload();
    await expect(composer).toHaveValue(new RegExp(file.id));
  } finally {
    await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
  }
});

test('file loading error can be retried; large Markdown has an explicit preview limit and complete source copy', async ({
  page,
  request,
}) => {
  const chat = await upload(request);
  let fail = true;
  const large = '# Documento grande\n\n' + 'testo '.repeat(35_000) + '\nFINE ORIGINALE';
  await page.route('**/api/conversations/*/files/*', (route) =>
    fail
      ? route.fulfill({ status: 503, body: 'Offline' })
      : route.fulfill({ contentType: 'text/markdown', body: large }),
  );
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          (window as any).copiedText = text;
        },
      },
    }),
  );
  try {
    await page.goto(`/?chat=${chat.id}`);
    await page.locator('.file-card').getByRole('button', { name: 'Apri', exact: true }).click();
    const reader = page.getByRole('dialog', { name: 'Documento: piano.MD' });
    await expect(reader.getByRole('alert')).toContainText('Non riesco ad aprire');
    fail = false;
    await reader.getByRole('button', { name: 'Riprova' }).click();
    await expect(reader.getByText(/Anteprima dei primi 200.000/)).toBeVisible();
    await reader.getByRole('button', { name: 'Copia sorgente' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).copiedText)).toBe(large);
  } finally {
    await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
  }
});

test('global skills use the reader and asking attaches the exact skill without modifying it', async ({
  page,
  request,
}) => {
  const chat = await (
    await request.post('/api/conversations', {
      data: { agent: 'codex', title: 'Domanda su skill' },
    })
  ).json();
  const name = `reader-skill-${Date.now()}`;
  const skillContent = `---\nname: ${name}\ndescription: Skill per la prova del lettore.\n---\n# Istruzioni\n\nSpiega il documento.\n`;
  const skill = await (
    await request.post('/api/skills', { data: { content: skillContent, agents: ['codex'] } })
  ).json();
  try {
    await page.goto(`/?chat=${chat.id}&settings=skills`);
    const settings = page.getByRole('dialog', { name: 'Skill', exact: true });
    await settings.getByRole('button', { name: `Leggi ${name}`, exact: true }).click();
    const reader = page.getByRole('dialog', { name: `Documento: ${name}.md`, exact: true });
    await expect(reader.getByRole('heading', { name: 'Istruzioni', exact: true })).toBeVisible();
    await reader.getByRole('button', { name: 'Sorgente', exact: true }).click();
    await expect(reader.locator('.md-source')).toHaveText(skillContent);
    await reader.getByRole('button', { name: 'Chiedi su questo file' }).click();
    await expect(reader).toBeHidden();
    await expect(settings).toBeHidden();
    await expect(page.getByLabel('Allegati da inviare')).toContainText(`${name}.md`);
    await expect(page.getByRole('textbox', { name: 'Messaggio', exact: true })).toHaveValue(
      new RegExp(name),
    );
    expect((await (await request.get(`/api/conversations/${chat.id}`)).json()).messages).toEqual(
      [],
    );
    expect((await (await request.get(`/api/skills/${skill.id}`)).json()).content).toBe(
      skillContent,
    );
    await page.reload();
    await expect(settings).toBeHidden();
    expect(new URL(page.url()).searchParams.has('settings')).toBe(false);
    await expect(page.getByLabel('Allegati da inviare')).toContainText(`${name}.md`);
  } finally {
    await request.post(`/api/skills/${skill.id}/delete`, { data: {} });
    await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
  }
});
