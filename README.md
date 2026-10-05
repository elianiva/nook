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

The Import, the Decks, and the review flow run end to end. The offline queue
and the sync protocol do not: Review is online only.

What runs today:

- A Foldkit client and a Worker, served together on one port by
  `alchemy dev` and deployed by Alchemy to Cloudflare.
- A Cloudflare Access application that Alchemy creates and deletes with the
  Worker.
- Decks, the overview, and each Deck page, read from D1 through Foldkit
  Queries: each read holds its last answer, reloads in place, and ignores a
  late response from an older request. Settings is a plain fetch, because its
  answer resets the form (`docs/adr/0004`).
- An Import. The Decks page reads a `.apkg` archive in the browser — a Worker
  cannot, because workerd's `node:sqlite` is a stub and the wasm engine only
  loads in a browser — and streams the archive's Note Types, Decks, Notes, and
  Cards into D1 in batches. The read runs in a Web Worker, which pushes the
  progress the panel shows after every batch instead of the page polling for
  it. The Import is keyed by the archive's content hash, so importing the same
  file twice overwrites instead of duplicating, and a run that fails midway
  resumes from the cursors it left behind. The archive is kept in IndexedDB
  while a run is in flight, so a reload resumes it and a stopped run can Retry
  without another file pick. Media streams into R2, and the Worker serves it
  from `/api/media`.
- A Review. The Worker serves a queue of due and new Cards with both sides
  already rendered from the Note Type's Template and stylesheet, and the app
  grades them. Each Grade is one append-only row in the Review log plus the
  Card's FSRS-6 state, written in one batch; a replayed Grade id is ignored
  (ADR 0002). A Grade reschedules the Card to a real due instant.

What is decided but not written: the offline queue and the sync protocol. See
[Design](#design) and [docs/adr](./docs/adr).

## What v1 does

- Import a modern `.apkg` archive: note types, fields, templates, styling,
  decks, tags, and media.
- Render Cards the way Anki renders them, including the Note Type's own CSS.
  Fields, `{{FrontSide}}`, conditionals, cloze deletions, `[sound:]`, and Media
  URLs are supported. LaTeX and TTS tags are not.
- Reset scheduling on import, so every imported Card starts as new.
- Schedule with FSRS-6 only. There is no SM-2 code path.
- Review online: the Worker serves a queue of due and new Cards, and a Grade
  reschedules the Card.

Still to come:

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
packages/anki      @nook/anki      The `.apkg` archive reader and the Card renderer
packages/api       @nook/api       The RPC contract, the Drizzle schema, types
packages/backend   @nook/backend   Effect RPC handlers and the services behind them
alchemy.run.ts                     The Cloudflare stack
```

`packages/api` stays free of runtime behaviour. The browser bundle imports it,
so anything that needs a database client, a bucket, a clock, or a request
belongs in `packages/backend`.

`packages/anki` is pure: the reader opens an archive, and `@nook/anki/render`
turns a Note into a Card's two sides. The Worker imports the renderer without
pulling in the reader's browser-only SQLite engine.

Screens follow an Elm-style split: `model.ts`, `commands.ts`, `update.ts`, and
`view.ts`. Custom Foldkit lint rules enforce it and fail the build.

Reads follow the same split. `queries.ts` defines the Query submodels that own
each list and detail read; `api-commands.ts` keeps the writes and the review
queue.

## Design

Reads:

- The overview, the deck list, and one Deck by id are Foldkit Queries. Each
  owns its fetch, its `AsyncData` state, and a generation number that rejects a
  late answer from an older request. See
  [ADR 0004](./docs/adr/0004-queries-own-fetch-state.md).
- A failed read is local: the slice that failed shows its own message and
  Retry, and a read that fails after it has data keeps that data.

Storage:

- D1 holds the system of record. D1 has no transactions, so multi-statement
  writes use `db.batch()`. See
  [ADR 0003](./docs/adr/0003-d1-with-batch-instead-of-transactions.md).
- R2 holds Media, served through the Worker. The bucket is never public: every
  object is read through `/api/media/<name>`.
- Drizzle owns the schema and generates the migrations.

Scheduling:

- FSRS-6 runs on the server today. The algorithm is deterministic, so the
  device can run the same code offline later, and the server stays
  authoritative.
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
- `foldkit` and `@foldkit/ui` track the same version. The list and detail
  reads use `foldkit/experimental/query`, whose names and Model shape can
  change while the module stabilizes.
- `components.json` registers the `@foldcn` registry namespace, but
  `src/components/ui/` holds checked-in copies. Installing a component copies
  the source in; it is not fetched at build time.
