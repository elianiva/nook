/**
 * The app under test, run locally with no Cloudflare account.
 *
 * Miniflare runs the Worker entry (`apps/frontend/src/worker.ts`, bundled here the
 * way Alchemy bundles it for upload) on workerd, with a real D1 database, a real R2 bucket, and the static asset
 * layer in front, wired the way `alchemy.run.ts` declares them: `/api/*` goes to
 * the Worker first, every other path is an asset with an `index.html` fallback.
 * Google is absent, as under `alchemy dev`: the Worker signs in as the stand-in
 * `DEV_USER_EMAIL` on this loopback host. State is in memory, so each run starts from an empty collection.
 *
 * Run by Playwright's `webServer`; it builds the app first when asked to.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
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
  // Private: the public `port` opens only once the schema exists (see below).
  port: 0,
  modules: [{ type: 'ESModule', path: 'worker.js', contents: worker.outputFiles[0]?.contents }],
  compatibilityDate: '2026-08-01',
  compatibilityFlags: ['nodejs_compat'],
  // The same stand-in identity `alchemy dev` binds: an approved admin, so the
  // browser is let in as it is locally.
  bindings: {
    ADMIN_EMAIL: 'e2e@example.com',
    DEV_USER_EMAIL: 'e2e@example.com',
    BETTER_AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e',
  },
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

const target = new URL(String(await mf.ready))

// Playwright treats the first answer on `port` as "ready". Miniflare answers
// from construction, before the migrations above have run, so the port is
// opened by this proxy after them instead.
const proxy = createServer((incoming, outgoing) => {
  const upstream = httpRequest(
    {
      host: target.hostname,
      port: target.port,
      path: incoming.url,
      method: incoming.method,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(outgoing)
    },
  )
  upstream.on('error', () => outgoing.destroy())
  incoming.pipe(upstream)
})
await new Promise<void>((resolve) => proxy.listen(port, resolve))
console.log(`nook e2e ready on http://localhost:${port}`)

const stop = async () => {
  proxy.close()
  await mf.dispose()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
