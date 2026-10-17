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
 *
 * The `MEDIA` binding is the R2 bucket a Card's images and audio live in. The
 * bucket is never public: the Worker serves every object through `/api/media`.
 */
class Website extends Cloudflare.Website.Foldkit<Website>()(
  'nook',
  Effect.gen(function* () {
    // Declared here rather than inline on the Worker so its audience tag is an
    // output the Worker can be told, and verify the Access token against.
    // Alchemy creates it with the Worker and deletes it with the Worker.
    const access = yield* Cloudflare.Access.Application('Access', {
      type: 'self_hosted',
      name: 'nook',
      // One allow rule, one email.
      policies: [{ decision: 'allow', include: [{ email: allowedEmail }] }],
      autoRedirectToIdentity: true,
    })
    return {
      rootDir: 'apps/frontend',
      main: 'src/worker.ts',
      env: {
        DB: Cloudflare.D1.Database('nook-db', {
          migrations: './packages/backend/migrations',
        }),
        MEDIA: Cloudflare.R2.Bucket('nook-media', {}),
        ACCESS_TEAM_DOMAIN: accessTeamDomain,
        ACCESS_AUD: access.aud,
        ALLOWED_EMAIL: allowedEmail,
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
      access,
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
    }
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
