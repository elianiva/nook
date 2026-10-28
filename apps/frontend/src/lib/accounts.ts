/**
 * Account routes: who am I, and the admin's user management.
 *
 * Answered by the Worker outside the RPC group: they are about the account,
 * not the collection, and `/api/me` must answer a user who is not approved yet.
 * Every change needs a same-origin request, so a page on another site cannot
 * make a signed-in browser approve or delete anyone.
 */

import { Effect } from 'effect'
import { SqlLive, deleteAccount, listAccounts, setAccountStatus } from '@nook/backend'
import { ADMIN_PATH, ME_PATH } from './api'
import type { AuthEnv, Identity } from './auth'
import { deleteUserMedia, type MediaBucket } from './media'

const json = (body: unknown, status = 200): Response => Response.json(body, { status })

const run = <A, E, R>(env: AuthEnv, effect: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(SqlLive(env.DB))) as Effect.Effect<A>)

export const isAccountPath = (pathname: string): boolean =>
  pathname === ME_PATH || pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`)

/** `null` when the path is not an account route. */
export const accountResponse = async (
  env: AuthEnv & { MEDIA: MediaBucket },
  request: Request,
  url: URL,
  identity: Identity,
): Promise<Response> => {
  const method = request.method
  if (method !== 'GET' && request.headers.get('origin') !== url.origin) {
    return json({ error: 'cross-origin' }, 403)
  }

  if (url.pathname === ME_PATH) {
    if (method === 'GET') return json(identity)
    if (method === 'DELETE') {
      if (identity.role === 'admin') return json({ error: 'admin-cannot-delete' }, 400)
      await deleteUserMedia(env.MEDIA, identity.id)
      await run(env, deleteAccount(identity.id))
      return json({ ok: true })
    }
    return json({ error: 'method' }, 405)
  }

  // Everything below is the admin's.
  if (identity.role !== 'admin' || identity.status !== 'approved') {
    return json({ error: 'forbidden' }, 403)
  }
  const rest = url.pathname.slice(ADMIN_PATH.length).split('/').filter(Boolean)

  if (rest.length === 1 && rest[0] === 'users' && method === 'GET') {
    return json({ users: await run(env, listAccounts) })
  }
  const [, userId, action] = rest
  if (rest[0] === 'users' && userId !== undefined && userId !== identity.id) {
    if (method === 'POST' && (action === 'approve' || action === 'reject')) {
      await run(env, setAccountStatus(userId, action === 'approve' ? 'approved' : 'rejected'))
      return json({ ok: true })
    }
    if (method === 'DELETE' && action === undefined) {
      const target = (await run(env, listAccounts)).find((account) => account.id === userId)
      if (target === undefined) return json({ error: 'not-found' }, 404)
      if (target.role === 'admin') return json({ error: 'admin-cannot-delete' }, 400)
      await deleteUserMedia(env.MEDIA, userId)
      await run(env, deleteAccount(userId))
      return json({ ok: true })
    }
  }
  return json({ error: 'not-found' }, 404)
}
