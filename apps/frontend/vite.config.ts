import { defineConfig } from 'vite'
import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // App mode: `vite build` builds every environment this config declares, not
  // just `client`. That makes `pnpm build` a gate on the same Worker bundle
  // Alchemy uploads, instead of on a client-only build nobody deploys.
  builder: {},
  plugins: [
    tailwindcss(),
    ...foldkit(),
    // `injectManifest` keeps the custom worker in `src/sw.ts`: the plugin
    // precaches the client build output (no hand-written shell list, no
    // manual version bump) and injects its manifest into the worker. The
    // manifest file stays hand-written in `public/`, so `manifest: false`.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: false,
      injectRegister: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,webmanifest}'],
        // Fonts ship inside the JS/CSS bundle (Fontsource), not as loose
        // files, so the precache stays small. Media and API JSON are runtime
        // concerns of `src/sw.ts`, never precache entries.
        globIgnores: ['**/workerd-stub.js', 'ssr/**/*'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    tsconfigPaths: true,
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
