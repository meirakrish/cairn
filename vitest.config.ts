import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    globalSetup: ['packages/core/src/testing/global-setup.ts'],
    // Test files share one database and Redis db, and reset them between tests.
    fileParallelism: false,
  },
});
