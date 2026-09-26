import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// node-pty's packaged macOS spawn helper can lose its executable bit in npm.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('node-pty/package.json'));
  const helper = path.join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
