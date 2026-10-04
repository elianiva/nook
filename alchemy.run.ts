import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'

/**
 * The one email Cloudflare Access admits.
 *
 * nook has no accounts and no sign-up, so this value is the whole identity
 * system. There is no default: an unset value would leave a personal
 * collection reachable by anyone who finds the domain.
 */
const allowedEmail = process.env['NOOK_ALLOWED_EMAIL']

if (allowedEmail === undefined || allowedEmail === '') {
  throw new Error(
    'NOOK_ALLOWED_EMAIL must name the one email Cloudflare Access admits. ' +
      'nook has no sign-up, so there is nothing else between a stranger and the collection.',
  )
}

/**
 * The hostname nook answers on. Override it to self-host under your own
 * domain.
 */
const domain = process.env['NOOK_DOMAIN'] ?? 'nook.elianiva.com'

/**
 * The whole site: a Foldkit client build served as static assets, with a
 * custom Worker entry (`apps/frontend/src/worker.ts`) that answers the API on
 * `/api/*` and falls through to `env.ASSETS` for everything else.
 *
 * `Website.Foldkit` drives the app's own `vite build` and uploads the client
 * output; `main` is the Worker entry it bundles alongside the assets.
 *
 * The `DB` binding is the D1 database the Worker reads through `SqlLive`.
 * Its schema and showcase seed come from `packages/backend/migrations`,
 * applied on each deploy into Alchemy's `__alchemy_migrations` bookkeeping.
 */
class Website extends Cloudflare.Website.Foldkit<Website>()('nook', {
  rootDir: 'apps/frontend',
  main: 'src/worker.ts',
  env: {
    DB: Cloudflare.D1.Database('nook-db', {
      migrations: './packages/backend/migrations',
    }),
  },
  domain,
  access: {
    name: 'nook',
    // One allow rule, one email. Alchemy creates this Access application with
    // the Worker and deletes it with the Worker, so the policy cannot drift
    // away from the thing it protects.
    policies: [{ decision: 'allow', include: [{ email: allowedEmail }] }],
    autoRedirectToIdentity: true,
  },
  assets: {
    // `/api/*` is the Worker's; every other path is served by the asset layer,
    // which falls back to `index.html` for client routes.
    runWorkerFirst: ['/api/*'],
  },
  dev: {
    port: 5273,
    strictPort: true,
    // `alchemy dev` has no Access service in front of it, so it stands in an
    // identity and the Worker reads a real one.
    access: { aud: 'dev', identity: { email: allowedEmail } },
  },
}) {}

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>

export default Alchemy.Stack(
  'nook',
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const website = yield* Website

    return {
      url: website.url,
    }
  }),
)
