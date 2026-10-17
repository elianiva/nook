<h1 align="center">
  <img src="apps/frontend/public/icons/icon-512.png" alt="nook logo" width="72" /> nook
</h1>

nook is a self-hosted, Android-first spaced repetition app. Import an Anki
deck, then review on your phone or desktop—with or without an internet
connection. nook is an installable progressive web app (PWA) and uses FSRS-6
to schedule reviews.

Your collection stays in your Cloudflare account. Cloudflare Access restricts
the app to one email address; nook has no separate accounts or sign-up.

## Screenshots

These screenshots show the mobile layout.

<p align="center">
  <a href="docs/screenshots/home.png"><img src="docs/screenshots/home.png" alt="nook home screen on mobile" width="24%" /></a>
  <a href="docs/screenshots/deck-detail.png"><img src="docs/screenshots/deck-detail.png" alt="nook deck details screen on mobile" width="24%" /></a>
  <a href="docs/screenshots/review.png"><img src="docs/screenshots/review.png" alt="nook review screen on mobile, with the answer revealed" width="24%" /></a>
</p>

## Features

- Import modern Anki `.apkg` decks, including note types, templates, styling,
  tags, and media. Imported cards start with no review history.
- Review due and new cards with FSRS-6. Undo your last review, and use daily
  review limits.
- Install the PWA and review offline using a queue of up to 200 prefetched
  cards. Reviews sync when you reconnect.
- Export your collection as JSON, including scheduling state and review
  history. Media files remain in Cloudflare R2 and are not included.

nook is for reviewing, not authoring: it has no card editor or delete function.
You cannot restore a collection from a JSON export yet.

## Requirements

- Node.js 24 or later
- pnpm 12
- A Cloudflare account and a Zero Trust organization for Cloudflare Access
- A Cloudflare API token and account ID, or an `alchemy` login in `~/.alchemy`

## Get started

Choose the email address that can access your local instance, install the
dependencies, and start the dev server:

```bash
export NOOK_ALLOWED_EMAIL=you@example.com
pnpm install
pnpm dev
```

Open <http://localhost:5273>. `alchemy dev` serves both the app and its Worker;
you do not need to start a second process. Locally, the `dev.access` identity
stands in for Cloudflare Access.

## Configuration

| Variable             | Required | Default             | Purpose                                        |
| -------------------- | -------- | ------------------- | ---------------------------------------------- |
| `NOOK_ALLOWED_EMAIL` | Yes      | —                   | The only email address allowed to access nook. |
| `NOOK_DOMAIN`        | No       | `nook.elianiva.com` | Hostname for the deployed app.                 |

`NOOK_ALLOWED_EMAIL` is required. There is no sign-up flow, and
`alchemy.run.ts` will not load without this value.

## Observability

Deploys turn on Workers Logs (`observability` in `alchemy.run.ts`). Read them in
the Cloudflare dashboard under the Worker's Logs tab. Storage failures, grades
for unknown Cards, failed imports and unhandled Worker errors are logged with
fields such as `operation`, `cardId`, `importId`, `method` and `path`. Card
content, request bodies, query strings, headers and secrets are never logged.

## Commands

```bash
pnpm dev            # Start the app and Worker
pnpm check          # Format, lint, and type-check
pnpm test           # Run tests (excludes the slow Kaishi archive test)
pnpm test:kaishi    # Run tests, including the Kaishi archive test
pnpm typecheck      # Type-check all packages
pnpm build          # Build the app and bundle the Worker
pnpm fmt            # Format the code
pnpm lint           # Lint the code
pnpm infra:deploy   # Deploy to Cloudflare's prod stage
```

## Deploy

`pnpm infra:deploy` deploys the Worker, static assets, and Cloudflare Access
application defined in `alchemy.run.ts`.

**Before forking:** `.github/workflows/deploy.yml` deploys every `master` commit
whose `CI` workflow run succeeds, and can also be started manually with
`workflow_dispatch` (which skips the CI gate). Change that workflow if you do
not want your fork to publish automatically.

## Anki compatibility

nook imports modern `.apkg` files in the format written by Anki 26.x. It
supports note fields, `{{FrontSide}}`, conditionals, cloze deletions,
`[sound:]` references, and media URLs, along with each note type's CSS. LaTeX
and text-to-speech tags are not supported.

Legacy exports are not supported. In Anki, turn off **Support older Anki
versions** and export the deck again. nook does not import Anki scheduling
history or deck options, and it does not sync with AnkiWeb. Imported cards
start new and are scheduled by nook's FSRS-6 implementation.

## Project layout

```
apps/frontend      @nook/frontend  The Foldkit app and Worker entry point
packages/anki      @nook/anki      Anki archive reader and card renderer
packages/api       @nook/api       RPC contract, Drizzle schema, and types
packages/backend   @nook/backend   RPC handlers and backend services
alchemy.run.ts                     Cloudflare infrastructure
```

The API package contains shared contracts and types; database and storage
operations live in the backend. The Anki renderer is separate from the
browser-only archive reader, so the Worker can render cards without bundling
the reader.

The app uses an Elm-style structure for screens: `model.ts`, `commands.ts`,
`update.ts`, and `view.ts`. Custom Foldkit lint rules enforce this structure.

## Design notes

- D1 stores the collection and R2 stores media. Media is served through the
  Worker and is not publicly exposed. Multi-statement writes use D1 batches.
- The server schedules reviews and remains authoritative. Each review is
  recorded in an append-only log; replayed review IDs are ignored. This log
  also syncs reviews made offline.
- The device stores prefetched cards and offline reviews in IndexedDB. The
  service worker caches the app shell for installation and offline use.
- Foldkit Queries manage the overview and deck reads, including loading,
  errors, retries, and stale responses. See
  [ADR 0004](./docs/adr/0004-queries-own-fetch-state.md).

More detail is available in the [architecture decision records](./docs/adr):
[offline review](./docs/adr/0001-review-from-a-prefetched-queue.md),
[review ordering](./docs/adr/0002-the-server-orders-reviews.md), and
[D1 writes](./docs/adr/0003-d1-with-batch-instead-of-transactions.md).

## Toolchain notes

- Install dependencies with pnpm. The workspace applies a required patch to
  Effect 4.0.0; bypassing pnpm can cause a runtime error.
- `foldkit/experimental/query` is used for deck and overview reads. Its API may
  change while Foldkit stabilizes it.

## License

nook is available under the MIT License. See [LICENSE](./LICENSE).
