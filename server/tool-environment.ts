import path from 'node:path';

// Tools installed by the user live on the same persistent volume as agent data.
export function toolEnvironment(dataDir: string, home: string, inheritedPath = '') {
  const prefix = path.join(path.resolve(dataDir), 'tools');
  return {
    PA_TOOLS_PREFIX: prefix,
    NPM_CONFIG_PREFIX: prefix,
    PATH: [
      ...new Set([
        path.join(prefix, 'bin'),
        path.join(home, '.local/bin'),
        path.join(home, '.railway/bin'),
        path.join(home, '.cargo/bin'),
        path.join(home, '.bun/bin'),
        ...inheritedPath.split(path.delimiter).filter(Boolean),
      ]),
    ].join(path.delimiter),
  };
}
