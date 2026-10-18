import { defineConfig } from 'tsdown';

// Workspace packages ship TypeScript source, so bundle them into the output.
export default defineConfig({
  entry: ['src/index.ts'],
  platform: 'node',
  target: 'node22',
  format: 'esm',
  noExternal: [/^@cairn\//],
});
