# Queries own fetch state

The list and detail reads — the overview, the deck list, and one Deck by id —
are Foldkit Queries. Each Query owns its fetch Command, the `AsyncData` state
that fetch lands in, and a generation number that rejects a late answer from an
older request. `update` folds a Query's Message through a lifted fold and starts
it with `revalidateOrLoad`; the view reads the `AsyncData` and renders loading,
failure, and data.

We chose this over the hand-rolled alternative, where every fetch was a Command
and every answer a `Got*` Message that wrote a plain field, because that version
had no answer for a slow response. The deck page fetched by id and wrote
whatever came back, so a slow answer for Deck A could land after a navigation to
Deck B and overwrite it. The generation number in a Query closes that race, and
the parent gets per-id retention for free: returning to a Deck shows its last
answer while a fresh one arrives instead of an empty page.

We keep Settings and the review queue as plain Commands. A settings answer
writes two fields (the settings and the form draft) and a review queue belongs
to a session with its own cursor, so neither is one retained resource. The
[Query guide](https://foldkit.dev/core/query) calls that the `AsyncData`-direct
case.

## Consequences

- `apps/frontend/src/app/queries.ts` defines every read. `api-commands.ts` holds
  only the settings Save, the Grade, and the review queue.
- A read's failure is local: the slice that failed renders the error and its own
  Retry. The shell notice now covers only Settings and the review queue.
- A Query that fails after it has data keeps that data (`Stale`) instead of
  dropping to an empty screen.
- `Model` embeds each Query's generated Model. Do not replace a live Query with
  `init()`; call `reset` when a Query must be cleared.
- Query ships from `foldkit/experimental`, so its names and Model shape can
  change before it stabilizes.
