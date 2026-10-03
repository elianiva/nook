# Review from a prefetched queue, not from the server

nook is offline-first: the device holds the next 200 Cards, already rendered,
and grades them locally. Every grade is a local write with no network wait, and
the device refills its queue from the server when it runs low. We chose this
over fetching one Card at a time, which is correct but not instant, and over
pulling the whole collection the way Anki does, which is why Anki is slow to
open. See [ADR 0002](./0002-the-server-orders-reviews.md) for the write side.
