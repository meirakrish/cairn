import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const core = JSON.parse(readFileSync('../../packages/core/package.json', 'utf8')) as {
  dependencies: Record<string, string>;
};

// Workspace packages ship TypeScript source, so bundle them into the output.
// Their own dependencies (jsdom, sharp, ...) stay external: some read files next to their code.
export default defineConfig({
  entry: ['src/index.ts'],
  platform: 'node',
  target: 'node22',
  format: 'esm',
  noExternal: [/^@cairn\//],
  external: Object.keys(core.dependencies).filter((name) => !name.startsWith('@cairn/')),
});
