import { test, expect } from '@playwright/test';

const code = `const report = { title: 'Riepilogo', note: '${'testo lungo '.repeat(24)}' };\nconsole.log(report);\n`;
const content = `# Riepilogo del progetto

Un testo con **grassetto**, *corsivo*, ~~una nota superata~~ e \`codice in linea\`.

## Confronto

| Funzione | Stato | Responsabile | Prossimo passo | Scadenza |
| :--- | :---: | --- | --- | ---: |
| **Tabelle** | Pronta | Francesca | Verificare la lettura dal telefono | 12 ottobre |
| Codice | In corso | Marco | Copiare il blocco completo | 15 ottobre |

### Cose da verificare

1. Leggere il documento.
   - Controllare i dettagli.
   - Verificare gli spazi.
2. Preparare il riepilogo.

- [x] Tabella leggibile
- [ ] Ultima verifica

> Una citazione breve con **un punto importante**.

---



## Esempio di codice

\`\`\`javascript
${code}\`\`\`

[Documentazione](https://example.com/docs)

[Link non sicuro](javascript:alert(1))

Una nota[^verifica].

[^verifica]: Dettagli della verifica.

<script>window.untrustedMarkdown = true</script>
`;

for (const viewport of [
  { width: 320, height: 700 },
  { width: 1440, height: 900 },
]) {
  test(`chat Markdown renders tables and code without page overflow at ${viewport.width}px`, async ({
    page,
    request,
  }) => {
    const chat = await (
      await request.post('/api/conversations', {
        data: { agent: 'codex', title: 'Risposta formattata' },
      })
    ).json();
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as any).copiedText = text;
          },
        },
      });
    });
    await page.route(`**/api/conversations/${chat.id}`, async (route) => {
      const data = await (await route.fetch()).json();
      data.messages = [
        {
          id: 'format-test',
          role: 'assistant',
          text: content,
          created_at: Date.now(),
          attachments: [],
        },
      ];
      await route.fulfill({ json: data });
    });
    try {
      await page.goto(`/?chat=${chat.id}`);
      const message = page.locator('.message.assistant');
      await expect(message.getByRole('heading', { name: 'Riepilogo del progetto' })).toBeVisible();
      await expect(message.locator('table')).toHaveCount(1);
      await expect(message.locator('th')).toHaveCount(5);
      await expect(message.locator('tbody tr')).toHaveCount(2);
      await expect(message.locator('th').last()).toHaveCSS('text-align', 'right');
      await expect(message.locator('ol > li > ul')).toHaveCount(1);
      await expect(message.locator('input[type=checkbox]').first()).toBeChecked();
      await expect(message.locator('input[type=checkbox]').first()).toBeDisabled();
      await expect(message.locator('del')).toHaveText('una nota superata');
      await expect(message.locator('blockquote')).toContainText('un punto importante');
      await expect(message.locator('a[href^="javascript:"]')).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).untrustedMarkdown)).toBeUndefined();
      await expect(message.locator('script')).toHaveCount(0);
      await expect(message).toContainText('<script>window.untrustedMarkdown = true</script>');
      await expect(message.getByRole('link', { name: 'Documentazione' })).toHaveAttribute(
        'rel',
        'noopener noreferrer',
      );
      await message.locator('a[data-footnote-ref]').click();
      await expect(
        message.getByText('Dettagli della verifica.', { exact: false }),
      ).toBeInViewport();
      expect(page.context().pages()).toHaveLength(1);
      const table = message.getByRole('region', { name: 'Tabella scorrevole' });
      await table.scrollIntoViewIfNeeded();
      if (viewport.width === 320) {
        expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
        await table.evaluate((el) => {
          el.scrollLeft = el.scrollWidth;
        });
        expect(await table.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
        await expect(message.locator('td').last()).toBeInViewport();
        await table.evaluate((el) => {
          el.scrollLeft = 0;
        });
      }
      await page.screenshot({ path: `test-results/chat-table-${viewport.width}.png` });
      await message.getByRole('button', { name: 'Copia tabella', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => (window as any).copiedText))
        .toBe(
          'Funzione\tStato\tResponsabile\tProssimo passo\tScadenza\nTabelle\tPronta\tFrancesca\tVerificare la lettura dal telefono\t12 ottobre\nCodice\tIn corso\tMarco\tCopiare il blocco completo\t15 ottobre',
        );
      await message.getByRole('button', { name: 'Copia codice', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).copiedText)).toBe(code);
      const block = message.getByLabel('Blocco di codice');
      expect(await block.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await expect(block).toHaveCSS('white-space', 'pre');
      expect(
        await page.locator('.messages').evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `test-results/chat-code-${viewport.width}.png` });
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            writeText: async () => {
              throw new Error('denied');
            },
          },
        }),
      );
      await message.getByRole('button', { name: 'Copia codice', exact: true }).click();
      await expect(message.getByRole('status').last()).toContainText('Copia non disponibile');
    } finally {
      await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
    }
  });
}

test('streaming previews use the same table and code formatting as saved replies', async ({
  page,
  request,
}) => {
  const chat = await (
    await request.post('/api/conversations', { data: { agent: 'codex' } })
  ).json();
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (String(url) === '/api/events') (window as any).chatEvents = this;
      }
    };
  });
  await page.route(`**/api/conversations/${chat.id}`, async (route) => {
    const data = await (await route.fetch()).json();
    data.runs = [{ id: 'stream-test', status: 'running' }];
    await route.fulfill({ json: data });
  });
  try {
    await page.goto(`/?chat=${chat.id}`);
    await expect(page.getByText('Puoi cambiare chat. Il lavoro continua.')).toBeVisible();
    for (const text of ['| Funzione | Stato |\n| --- | --- |\n| Lettura | In', content]) {
      await page.evaluate(
        ({ id, text }) => {
          (window as any).chatEvents.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ type: 'agent_text', conversationId: id, text }),
            }),
          );
        },
        { id: chat.id, text },
      );
      await expect(page.locator('.preview table')).toHaveCount(1);
      expect(
        await page.locator('.messages').evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
    await expect(
      page.locator('.preview').getByRole('button', { name: 'Copia codice' }),
    ).toBeVisible();
    await expect(page.locator('.preview .chat-markdown')).toHaveCSS('font-size', '16px');
  } finally {
    await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
  }
});
