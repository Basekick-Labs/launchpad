import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Deliberately does NOT use the sveltekit() plugin. These tests cover pure
// logic — parsers, classifiers, SQL builders — and pulling in SvelteKit would
// require a full `svelte-kit sync` before every run for no benefit.
//
// The trade-off is that `$env/*` and `$app/*` do not resolve here, so modules
// importing them (for example src/lib/server/arcConnection.ts, which imports
// $env/dynamic/private) cannot be unit tested. Exercise those through the
// running app instead.
export default defineConfig({
  resolve: {
    // Mirrors the aliases in tsconfig/svelte.config.js so tests import modules
    // exactly the way the application does.
    alias: {
      $lib: resolve(__dirname, 'src/lib'),
      $components: resolve(__dirname, 'src/lib/components'),
      $server: resolve(__dirname, 'src/lib/server'),
    },
  },
  test: {
    // Node, not jsdom: nothing here touches the DOM. Component tests would
    // need their own environment and the svelte plugin.
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
