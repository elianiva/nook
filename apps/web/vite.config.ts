import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), ...foldkit()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      // Effect 4.0.0 promoted every `effect/unstable/*` module to a top-level
      // export and deleted the old paths. Foldkit 0.164.0 still imports
      // `effect/unstable/http` (and its devtools imports
      // `effect/unstable/persistence`), so each deleted specifier is mapped
      // onto the module that replaced it.
      'effect/unstable/http': 'effect/http',
      'effect/unstable/persistence': 'effect/persistence',
      '@nook/shared': resolve(import.meta.dirname, '../../packages/shared/src/index.ts'),
      '@nook/api': resolve(import.meta.dirname, '../../packages/api/src/index.ts'),
    },
  },
  optimizeDeps: {
    entries: ['src/entry.ts'],
  },
})
