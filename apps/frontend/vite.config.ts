import { defineConfig } from 'vite'
import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // App mode: `vite build` builds every environment this config declares, not
  // just `client`. That makes `pnpm build` a gate on the same Worker bundle
  // Alchemy uploads, instead of on a client-only build nobody deploys.
  builder: {},
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
    },
  },
  optimizeDeps: {
    entries: ['src/entry.ts'],
    // The wasm SQLite driver resolves its `.wasm` from its own module URL, so
    // pre-bundling it would move the glue away from the file it looks for.
    exclude: ['@effect/sql-sqlite-wasm', '@effect/wa-sqlite'],
  },
  environments: {
    // `src/worker.ts` is the entry Alchemy treats as the Worker
    // (`main` in alchemy.run.ts). Building it here means a Worker that does not
    // bundle fails `pnpm build`, before any deploy.
    ssr: {
      build: {
        outDir: 'dist/ssr',
        rollupOptions: { input: 'src/worker.ts' },
      },
    },
  },
})
