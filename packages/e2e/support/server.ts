/**
 * The app under test, run locally with no Cloudflare account.
 *
 * Miniflare runs the Worker entry (`apps/frontend/src/worker.ts`, bundled here the
 * way Alchemy bundles it for upload) on workerd, with a real D1 database, a real R2 bucket, and the static asset
 * layer in front, wired the way `alchemy.run.ts` declares them: `/api/*` goes to
 * the Worker first, every other path is an asset with an `index.html` fallback.
 * Cloudflare Access is absent, as under `alchemy dev`, and the Worker reads no
 * identity. State is in memory, so each run starts from an empty collection.
 *
 * Run by Playwright's `webServer`; it builds the app first when asked to.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { splitStatements } from '../../backend/test/migrate.ts'

const root = join(import.meta.dirname, '..', '..', '..')
const dist = join(root, 'apps', 'frontend', 'dist')
const migrations = join(root, 'packages', 'backend', 'migrations')
const port = Number(process.env['NOOK_E2E_PORT'] ?? 5274)

const worker = await build({
  entryPoints: [join(root, 'apps', 'frontend', 'src', 'worker.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  conditions: ['workerd', 'worker', 'browser'],
  mainFields: ['module', 'main'],
  external: ['node:*', 'cloudflare:*'],
  logLevel: 'error',
})

const mf = new Miniflare({
  port,
  modules: [{ type: 'ESModule', path: 'worker.js', contents: worker.outputFiles[0]?.contents }],
  compatibilityDate: '2026-08-01',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'nook-e2e' },
  r2Buckets: { MEDIA: 'nook-e2e-media' },
  assets: {
    directory: dist,
    binding: 'ASSETS',
    routerConfig: { has_user_worker: true, static_routing: { user_worker: ['/api/*'] } },
    assetConfig: { not_found_handling: 'single-page-application' },
  },
})

const db = await mf.getD1Database('DB')
for (const file of readdirSync(migrations)
  .filter((name) => name.endsWith('.sql'))
  .sort()) {
  for (const statement of splitStatements(readFileSync(join(migrations, file), 'utf8'))) {
    await db.prepare(statement).run()
  }
}

await mf.ready
console.log(`nook e2e ready on http://localhost:${port}`)

const stop = async () => {
  await mf.dispose()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
