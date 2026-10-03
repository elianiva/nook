import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'

/**
 * The counter's durable state. One namespace, one key (`count`), read and
 * written by the Worker through the `COUNTER` binding.
 */
const CounterKv = Cloudflare.KV.Namespace('nook-counter', {
  title: 'nook-counter',
})

/**
 * The whole site: a Foldkit client build served as static assets, with a
 * custom Worker entry (`apps/web/src/worker.ts`) that answers the counter RPC
 * on `/api/rpc` and falls through to `env.ASSETS` for everything else.
 *
 * `Website.Foldkit` drives the app's own `vite build` and uploads the client
 * output; `main` is the Worker entry it bundles alongside the assets.
 */
class Website extends Cloudflare.Website.Foldkit<Website>()('nook', {
  rootDir: 'apps/web',
  main: 'src/worker.ts',
  domain: 'nook.elianiva.com',
  env: {
    COUNTER: CounterKv,
  },
  assets: {
    // `/api/*` is the Worker's; every other path is served by the asset layer,
    // which falls back to `index.html` for client routes.
    runWorkerFirst: ['/api/*'],
  },
  dev: {
    port: 5273,
    strictPort: true,
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
