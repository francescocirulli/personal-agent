import { createApp } from './app';
import { readConfig } from './config';
const config = readConfig();
const runtime = createApp(config);
const server = runtime.app.listen(config.port, config.host, () =>
  console.log(
    `Personal Agent: http://${config.host}:${config.port} (${config.demo ? 'dimostrazione' : 'CLI reali'})`,
  ),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await runtime.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
