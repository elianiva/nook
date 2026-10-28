/**
 * Who is calling.
 *
 * Sign-in is Google only, through Better Auth, which keeps its `user`,
 * `session`, `account`, and `verification` tables in the same D1 database as the
 * collection. Sign-up is open but access is not: a new account is `pending`
 * until an admin approves it, and only an `approved` user reaches the API.
 *
 * The one admin is `ADMIN_EMAIL`. Its first Google sign-in creates an approved
 * admin and hands it the collection that existed before there were users.
 */

import type { D1Database } from '@cloudflare/workers-types'
import { betterAuth } from 'better-auth'
import { Effect } from 'effect'
import { Kysely } from 'kysely'
import { D1Dialect } from 'kysely-d1'
import { SqlLive, adoptLegacyCollection, provisionUser } from '@nook/backend'

export type AuthEnv = {
  DB: D1Database
  /** Signs session cookies. At least 32 characters. */
  BETTER_AUTH_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** The Google account that becomes the admin on its first sign-in. */
  ADMIN_EMAIL?: string
  /** Local development only: skips Google and acts as this account. Honoured on loopback hosts alone. */
  DEV_USER_EMAIL?: string
}

export type Role = 'user' | 'admin'
export type Status = 'pending' | 'approved' | 'rejected'

export type Identity = {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly role: Role
  readonly status: Status
}

const sameEmail = (a: string, b: string | undefined): boolean =>
  b !== undefined && b !== '' && a.toLowerCase() === b.toLowerCase()

const run = <A, E>(
  env: AuthEnv,
  effect: Effect.Effect<A, E, import('effect/sql/SqlClient').SqlClient>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(SqlLive(env.DB))) as Effect.Effect<A>)

/**
 * One Better Auth instance for one request. Like the Effect layers it is built
 * per request: the bindings are an argument of `fetch`, and a cached instance
 * would hold I/O from the request that created it.
 */
/**
 * What every account needs before its first request: a settings row, and for
 * the admin the collection that predates users. Both are safe to repeat, so
 * this runs when the account is created and again at every sign-in, which
 * repairs an account whose first attempt failed partway.
 */
const ensureAccount = async (env: AuthEnv, userId: string): Promise<void> => {
  await run(env, provisionUser(userId))
  const row = await env.DB.prepare('SELECT "role" FROM "user" WHERE "id" = ?')
    .bind(userId)
    .first<{ role: string }>()
  if (row?.role === 'admin') await run(env, adoptLegacyCollection(userId))
}

export const createAuth = (env: AuthEnv, origin: string) =>
  betterAuth({
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET ?? '',
    database: { db: new Kysely({ dialect: new D1Dialect({ database: env.DB }) }), type: 'sqlite' },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
        prompt: 'select_account',
      },
    },
    user: {
      additionalFields: {
        role: { type: 'string', defaultValue: 'user', input: false },
        status: { type: 'string', defaultValue: 'pending', input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Only Google's verified email can claim the admin account.
            const admin = user.emailVerified === true && sameEmail(user.email, env.ADMIN_EMAIL)
            return { data: admin ? { ...user, role: 'admin', status: 'approved' } : user }
          },
          after: async (user) => ensureAccount(env, user.id),
        },
      },
      session: {
        create: { after: async (session) => ensureAccount(env, session.userId) },
      },
    },
  })

export type Auth = ReturnType<typeof createAuth>

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'

const toIdentity = (user: {
  id: string
  email: string
  name: string
  role?: unknown
  status?: unknown
}): Identity => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role === 'admin' ? 'admin' : 'user',
  status: user.status === 'approved' || user.status === 'rejected' ? user.status : 'pending',
})

/**
 * The signed-in user, or `null`. Under local development `DEV_USER_EMAIL`
 * stands in for Google: it signs in as that account without a session, and
 * only on a loopback host, so setting it on a deployed Worker changes nothing.
 */
export const identify = async (
  auth: Auth,
  env: AuthEnv,
  request: Request,
): Promise<Identity | null> => {
  const devEmail = env.DEV_USER_EMAIL
  if (devEmail !== undefined && devEmail !== '' && isLoopback(new URL(request.url).hostname)) {
    const context = await auth.$context
    const existing = await context.internalAdapter.findUserByEmail(devEmail)
    if (existing !== null) return toIdentity(existing.user)
    const created = await context.internalAdapter.createUser(
      { email: devEmail, name: devEmail, emailVerified: true },
      { method: 'api' },
    )
    return toIdentity(created)
  }
  const session = await auth.api.getSession({ headers: request.headers })
  return session === null ? null : toIdentity(session.user)
}
