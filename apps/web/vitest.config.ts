import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function loadDotEnvIntoProcessEnv(dir: string): void {
  let contents: string;
  try {
    contents = readFileSync(path.join(dir, '.env'), 'utf-8');
  } catch {
    return;
  }
  for (const line of contents.split('\n')) {
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = (match[2] ?? '').trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

export default defineConfig(() => {
  // Prisma-touching tests need DATABASE_URL on process.env — some
  // environments (e.g. a freshly created git worktree) don't reliably
  // inherit it via turbo/pnpm, so load .env directly here rather than
  // depending on that propagation.
  loadDotEnvIntoProcessEnv(__dirname);

  return {
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./vitest.setup.ts'],
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
});
