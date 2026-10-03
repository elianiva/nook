# D1 with `db.batch` instead of a database with transactions

nook keeps its system of record in Cloudflare D1 and writes through Drizzle.
D1 rejects `BEGIN TRANSACTION`, so every multi-statement write goes through
`db.batch()`, which D1 runs atomically.

We chose this over a Durable Object with its own SQLite, which would have given
real transactions at the cost of routing every request for a Learner to one
object, and over Postgres, which leaves the Cloudflare stack entirely. It also
removes the need for a Durable Object at all: one Learner and `db.batch` are
enough.

## Consequences

There are no transactions in this codebase, and a reader looking for one will
not find it. Related: [ADR 0002](./0002-the-server-orders-reviews.md), which
explains why the write side is ordered rather than concurrent.
