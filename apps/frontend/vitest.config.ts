import { defineConfig } from 'vitest/config'

/**
 * The frontend's tests run in Node: they cover the Import state machine, the
 * worker protocol, and the IndexedDB decoder, none of which touch the DOM.
 *
 * The aliases mirror `vite.config.ts`. `@` is the source root, and the two
 * `effect/unstable/*` mappings exist because Foldkit still imports the
 * specifiers Effect 4.0.0 deleted.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
      'effect/unstable/http': 'effect/http',
      'effect/unstable/persistence': 'effect/persistence',
    },
  },
  test: {
    environment: 'node',
    server: {
      deps: {
        // Externalized dependencies are resolved by Node, which never sees the
        // aliases above, so Foldkit must be inlined for Vite to rewrite the
        // deleted `effect/unstable/http` specifier it imports.
        inline: ['foldkit'],
      },
    },
  },
})
