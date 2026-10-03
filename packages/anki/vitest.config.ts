import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /**
     * `@effect/vitest` imports `vitest` itself. Unless Vite inlines it, that
     * import runs outside the test file's own module graph, so the two copies
     * hold separate suite state and every test reports that it cannot find the
     * current suite.
     */
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
