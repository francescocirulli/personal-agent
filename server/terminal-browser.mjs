#!/usr/bin/env node
// Used by BROWSER and xdg-open inside the interactive terminal only.
const url = process.argv.slice(2).find((value) => /^https?:\/\//i.test(value));
if (!url || !process.env.PA_TERMINAL_BROWSER_URL || !process.env.PA_TERMINAL_BROWSER_TOKEN) {
  console.error('Browser non disponibile: apri il link dal pannello Terminale.');
  process.exit(1);
}
try {
  const response = await fetch(process.env.PA_TERMINAL_BROWSER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.PA_TERMINAL_BROWSER_TOKEN}`,
    },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error();
  console.log('Pagina aperta nel Browser del terminale nell’app.');
} catch {
  console.error(
    'Impossibile aprire la pagina. Apri il Browser del terminale e riprova con il link mostrato dalla CLI.',
  );
  process.exitCode = 1;
}
