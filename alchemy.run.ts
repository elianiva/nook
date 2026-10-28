import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'

/**
 * Whether this is `alchemy dev`. It has no Google to sign in with, so the
 * Worker stands in the admin account instead, and only on a loopback host.
 */
const isDev = process.argv.includes('dev')

/**
 * The Google account that becomes the admin on its first sign-in, and adopts
 * the collection that existed before nook had users. Everyone else signs up
 * as `pending` and waits for approval. There is no default: nobody could
 * approve anyone without it.
 */
const adminEmail = process.env['NOOK_ADMIN_EMAIL']

if (adminEmail === undefined || adminEmail === '') {
  throw new Error(
    'NOOK_ADMIN_EMAIL must name the Google account that administers nook. ' +
      'Without it nobody can approve a sign-up.',
  )
}

/**
 * Sign-in credentials. `BETTER_AUTH_SECRET` signs session cookies (at least 32
 * characters); the Google pair is an OAuth client whose redirect URI is
 * `https://<domain>/api/auth/callback/google`. A deploy without them cannot sign
 * anyone in, so it fails here instead of at the first sign-in.
 */
const authSecrets = ['BETTER_AUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const
const missingSecrets = authSecrets.filter((name) => (process.env[name] ?? '') === '')
if (!isDev && missingSecrets.length > 0) {
  throw new Error(`${missingSecrets.join(', ')} must be set to deploy nook.`)
}

/**
 * The hostname nook answers on. Override it to self-host under your own
 * domain.
 */
const domain = process.env['NOOK_DOMAIN'] ?? 'nook.elianiva.com'

/**
 * The one OpenRouter key the Worker generates stories with. Optional: without
 * it the stories feed still works on its sample passages and generation says it
 * is not set up. It is bound as a secret, so it never shows in the dashboard.
 */
const storyAiKey = process.env['NOOK_STORY_AI_KEY'] ?? ''

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
 *
 * The `MEDIA` binding is the R2 bucket a Card's images and audio live in. The
 * bucket is never public: the Worker serves every object through `/api/media`.
 */
class Website extends Cloudflare.Website.Foldkit<Website>()(
  'nook',
  Effect.succeed({
    rootDir: 'apps/frontend',
    main: 'src/worker.ts',
    env: {
      DB: Cloudflare.D1.Database('nook-db', {
        migrations: './packages/backend/migrations',
      }),
      MEDIA: Cloudflare.R2.Bucket('nook-media', {}),
      ADMIN_EMAIL: adminEmail,
      ...(isDev ? { DEV_USER_EMAIL: adminEmail } : {}),
      ...(isDev && missingSecrets.length > 0
        ? {}
        : {
            BETTER_AUTH_SECRET: Redacted.make(process.env['BETTER_AUTH_SECRET'] ?? ''),
            GOOGLE_CLIENT_ID: process.env['GOOGLE_CLIENT_ID'] ?? '',
            GOOGLE_CLIENT_SECRET: Redacted.make(process.env['GOOGLE_CLIENT_SECRET'] ?? ''),
          }),
      ...(storyAiKey === '' ? {} : { STORY_AI_KEY: Redacted.make(storyAiKey) }),
    },
    domain,
    // Workers Logs: every console line and Effect log is kept and searchable in
    // the dashboard, along with one invocation log per request.
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        invocationLogs: true,
        headSamplingRate: 1,
        persist: true,
      },
    },
    // Better Auth reads `AsyncLocalStorage`.
    compatibility: { flags: ['nodejs_compat'] },
    assets: {
      // `/api/*` is the Worker's; every other path is served by the asset layer,
      // which falls back to `index.html` for client routes.
      runWorkerFirst: ['/api/*'],
    },
    dev: {
      port: 5273,
      strictPort: true,
    },
  }),
) {}

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
