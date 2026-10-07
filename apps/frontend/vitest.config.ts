import { defineConfig } from 'vitest/config'

/**
 * The frontend's tests run in Node: they cover the Import state machine, the
 * worker protocol, and the IndexedDB decoder, none of which touch the DOM.
 *
 * `@` is the source root. The tests reach Foldkit through `app/update`, so
 * Foldkit is inlined for Vite to transform rather than externalized for Node
 * to resolve. `@effect/vitest` is inlined so it shares the test runner's suite state.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    server: {
      deps: {
        inline: ['foldkit', '@effect/vitest'],
      },
    },
  },
})
