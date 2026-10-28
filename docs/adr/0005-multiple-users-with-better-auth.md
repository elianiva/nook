# Multiple users: Better Auth, Google sign-in, user_id on every row

nook is hosted for several Learners, so Cloudflare Access (one allow-listed email) is replaced
by Better Auth with Google as the only sign-in. Its `user`, `session`, `account` and
`verification` tables live in the same D1 database as the collection.

Sign-up is open and access is not: a new account is `pending` until the Admin approves it, and
the Worker answers 403 on the collection API until then. `NOOK_ADMIN_EMAIL` becomes an approved
Admin on first sign-in and adopts the collection that existed before users.

We chose one shared D1 with a `user_id` column over a database or Durable Object per user. This
keeps [ADR 0003](./0003-d1-with-batch-instead-of-transactions.md) intact. We chose Better Auth
over Yielded Auth because Yielded Auth is still in beta and security code is a poor place for
a young library.

## Consequences

Ids come from Anki archives and exports, so they are not unique across Users. Every collection
table is keyed `(user_id, id)` and every reference carries `user_id`. Every SQL statement must
filter on the `CurrentUser` id; a missed filter leaks data, so `test/users.test.ts` checks
isolation per service. R2 keys start with the user id. Story generation uses one shared
provider key, capped per user per day (`story_usage`). Deleting an account removes its rows,
sessions and Media.
