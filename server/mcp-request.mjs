// Invoked by either CLI inside its active chat. Credentials stay in the environment.
const [action, json = '{}'] = process.argv.slice(2);
try {
  const response = await fetch(process.env.PA_MCP_REQUEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PA_MCP_REQUEST_TOKEN}` },
    body: JSON.stringify({ ...JSON.parse(json), action }),
    signal: AbortSignal.timeout(90000),
  });
  const result = await response.json();
  console.log(JSON.stringify(result));
  if (!response.ok) process.exitCode = 1;
} catch {
  console.error('Collegamento non riuscito. Usa Collegamenti MCP nella chat per riprovare.');
  process.exitCode = 1;
}
