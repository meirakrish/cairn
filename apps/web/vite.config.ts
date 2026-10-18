import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },
      // SPA: nginx serves index.html for unknown paths.
      adapter: adapter({ fallback: 'index.html' }),
    }),
  ],
  server: {
    // Same origin as production: the browser only talks to the web origin.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
