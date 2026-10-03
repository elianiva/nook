# nook

A spaced repetition system for one Learner. nook imports Anki decks, schedules
Cards with FSRS, and runs a fast review on any device. Your collection lives in
the cloud, and the app behaves as if it does not need the network.

nook is personal software. One instance serves one Learner, and Cloudflare
Access guards it. There is no sign-up, no password, and no account to manage.

## Why

Anki is powerful and slow to use. Renshuu is fast and holds your collection
behind an account you do not control. nook aims at the gap between them: Anki's
deck format, FSRS scheduling, and a review that never waits for the network.

## Status

**The product is not built.** This repository currently holds the
infrastructure, the tooling, and the coding conventions the product will use.
The only screen is an app shell that reports whether the Worker answered. There
are no tests yet, because the demo that had the only one is gone.

What runs today:

- A Foldkit client and a Worker, served together on one port by
  `alchemy dev` and deployed by Alchemy to Cloudflare.
- A Cloudflare Access application that Alchemy creates and deletes with the
  Worker.
- The package layout the product will fill in.

What is decided but not written: the `.apkg` importer, FSRS scheduling, the
offline queue, and the sync protocol. See [Design](#design) and
[docs/adr](./docs/adr).

## What v1 will do

- Import a modern `.apkg` archive: note types, fields, templates, styling,
  decks, tags, and media.
- Render Cards the way Anki renders them, including the deck's own CSS.
- Reset scheduling on import, so every imported Card starts as new.
- Schedule with FSRS only. There is no SM-2 code path.
- Prefetch the next 200 Cards and grade them with no network wait.
- Sync an append-only Review log when the network returns.

v1 has no card editor. You import; you do not author.

## Requirements

- Node.js 24 or later
- pnpm 12
- A Cloudflare account. Alchemy reads `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`, or it uses an `alchemy` login from `~/.alchemy`.
- A Zero Trust organization, for Cloudflare Access.

## Getting started

Set the one email that may use the instance, then start the dev server:

```bash
export NOOK_ALLOWED_EMAIL=you@example.com
pnpm install
pnpm dev
```

`alchemy dev` serves the Worker and the Foldkit client on <http://localhost:5273>.
There is no second process to start. Access has no service in front of it
locally, so `dev.access` stands in an identity and the Worker reads a real one.

## Configuration

| Variable             | Required | Default             | Purpose                        |
| -------------------- | -------- | ------------------- | ------------------------------ |
| `NOOK_ALLOWED_EMAIL` | yes      | none                | The single email Access admits |
| `NOOK_DOMAIN`        | no       | `nook.elianiva.com` | The hostname nook answers on   |

`NOOK_ALLOWED_EMAIL` has no default on purpose. nook has no sign-up, so nothing
else stands between a stranger and your collection. `alchemy.run.ts` refuses to
load without it.

## Commands

```bash
pnpm install        # install the workspace
pnpm dev            # alchemy dev: the Worker and the Foldkit client on one port
pnpm check          # vp check: format, lint, and type-check
pnpm test           # turbo test
pnpm typecheck      # turbo typecheck
pnpm build          # turbo build; also bundles the Worker
pnpm fmt            # vp fmt
pnpm lint           # vp lint
pnpm infra:deploy   # alchemy deploy --stage prod --yes
```

`pnpm build` builds the Worker bundle as well as the client. The
`ssr` environment in `apps/frontend/vite.config.ts` exists so a Worker that
fails to bundle fails the build, before any deploy.

## Layout

```
apps/frontend      @nook/frontend  The Foldkit client and the Worker entry
packages/api       @nook/api       The RPC contract, the Drizzle schema, types
packages/backend   @nook/backend   Effect RPC handlers and the services behind them
alchemy.run.ts                     The Cloudflare stack
```

`packages/api` stays free of runtime behaviour. The browser bundle imports it,
so anything that needs a database client, a bucket, a clock, or a request
belongs in `packages/backend`.

Screens follow an Elm-style split: `model.ts`, `commands.ts`, `update.ts`, and
`view.ts`. Custom Foldkit lint rules enforce it and fail the build.

## Design

Storage:

- D1 holds the system of record. D1 has no transactions, so multi-statement
  writes use `db.batch()`. See
  [ADR 0003](./docs/adr/0003-d1-with-batch-instead-of-transactions.md).
- R2 holds Media, served through the Worker. The bucket is never public. It
  joins the stack with the first feature that stores a Card.
- Drizzle owns the schema and generates the migrations.

Scheduling:

- FSRS runs on the device and on the server. The algorithm is deterministic, so
  both compute the same Stability and Difficulty from the same inputs, and the
  server stays authoritative.
- Every Review is an append-only row. Card state is derived, never overwritten
  in place.

Sync:

- The device prefetches a queue and grades offline. See
  [ADR 0001](./docs/adr/0001-review-from-a-prefetched-queue.md).
- The server orders Reviews and ignores replays. See
  [ADR 0002](./docs/adr/0002-the-server-orders-reviews.md).

Identity:

- Cloudflare Access, configured inline on the Alchemy `access` prop. There are
  no accounts and no passwords in nook.

## Anki compatibility

nook reads the modern `.apkg` format that Anki 26.x writes: `collection.anki21`,
a `media` map, and numbered media files. Note types, fields, templates, and
decks come from the normalized tables `notetypes`, `fields`, `templates`, and
`decks`, not from the legacy JSON blobs in `col`.

Legacy exports are rejected with a message that tells the Learner to turn off
"Support older Anki versions" and export again.

nook does not read Anki's scheduling state, and does not import deck options.
Imported Cards start as new, FSRS learns them from your Reviews, and nook
applies its own global limits.

## Deploying

`pnpm infra:deploy` applies the Cloudflare stack in `alchemy.run.ts`: the
Worker, the static assets, and the Access application.

**Caution:** `.github/workflows/deploy.yml` runs `pnpm infra:deploy` on every
push to `master`. Change that before you fork this, or every push publishes.

## Notes on the toolchain

- `pnpm-workspace.yaml` pins every `@effect/*` package to 4.0.0 and applies
  `patches/effect@4.0.0.patch`. The patch is load-bearing: Foldkit redefines
  three `Schema` properties that Effect 4.0.0 defines as non-configurable, and
  an unpatched Effect throws at runtime. Install through pnpm, not around it.
- `apps/frontend/vite.config.ts` maps `effect/unstable/http` and
  `effect/unstable/persistence` onto their new top-level paths, because
  Foldkit 0.164.0 still imports the deleted specifiers.
- `components.json` registers the `@foldcn` registry namespace, but
  `src/components/ui/` holds checked-in copies. Installing a component copies
  the source in; it is not fetched at build time.
