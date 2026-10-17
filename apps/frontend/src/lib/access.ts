/**
 * Defence-in-depth for Cloudflare Access.
 *
 * Access sits in front of the Worker and rejects strangers before a request
 * arrives. This module makes the Worker check that itself, so a
 * misconfigured route, a `workers.dev` URL, or a deleted Access application
 * cannot expose the collection. It verifies the `Cf-Access-Jwt-Assertion`
 * header: signature against the team's JWKS, issuer, audience, expiry, and
 * that the email is the one allowed email.
 */

export type AccessEnv = {
  /** The Zero Trust team domain, e.g. `myteam.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string
  /** The Access application's audience tag. */
  ACCESS_AUD?: string
  /** The one email Access admits. */
  ALLOWED_EMAIL?: string
  /** Set only by `alchemy dev`, which has no Access service in front. */
  ALCHEMY_DEV_ACCESS?: { aud?: string; identity?: { email?: string } }
}

type Jwk = JsonWebKey & { kid?: string }

type Keys = { fetchedAt: number; keys: Jwk[] }

const KEY_TTL_MS = 60 * 60 * 1000
const KEY_REFETCH_COOLDOWN_MS = 60 * 1000
const CLOCK_SKEW_SECONDS = 60

const keyCache = new Map<string, Keys>()

const decoder = new TextDecoder()

const base64UrlToBytes = (input: string): Uint8Array<ArrayBuffer> => {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const parseSegment = (segment: string): unknown =>
  JSON.parse(decoder.decode(base64UrlToBytes(segment)))

const fetchKeys = async (teamDomain: string): Promise<Keys> => {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!response.ok) throw new Error(`JWKS request failed with ${response.status}`)
  const body = (await response.json()) as { keys?: Jwk[] }
  const keys = { fetchedAt: Date.now(), keys: body.keys ?? [] }
  keyCache.set(teamDomain, keys)
  return keys
}

/** The key for `kid`. Keys rotate, so an unknown `kid` refetches the set once
 *  per cooldown rather than on every forged token. */
const findKey = async (teamDomain: string, kid: string): Promise<Jwk | undefined> => {
  const cached = keyCache.get(teamDomain)
  const fresh = cached !== undefined && Date.now() - cached.fetchedAt < KEY_TTL_MS
  const current = fresh ? cached : await fetchKeys(teamDomain)
  const hit = current.keys.find((key) => key.kid === kid)
  if (hit !== undefined || Date.now() - current.fetchedAt < KEY_REFETCH_COOLDOWN_MS) return hit
  return (await fetchKeys(teamDomain)).keys.find((key) => key.kid === kid)
}

const sameEmail = (a: unknown, b: string): boolean =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

/** Whether `token` is a valid Access JWT for this application and email. */
export const verifyAccessJwt = async (
  token: string,
  config: { teamDomain: string; aud: string; email: string },
): Promise<boolean> => {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

    const header = parseSegment(headerPart) as { alg?: string; kid?: string }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false

    const jwk = await findKey(config.teamDomain, header.kid)
    if (jwk === undefined) return false
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`)
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64UrlToBytes(signaturePart),
      signed,
    )
    if (!valid) return false

    const claims = parseSegment(payloadPart) as {
      aud?: string | string[]
      iss?: string
      exp?: number
      nbf?: number
      email?: string
    }
    const now = Date.now() / 1000
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    return (
      claims.iss === `https://${config.teamDomain}` &&
      audiences.includes(config.aud) &&
      typeof claims.exp === 'number' &&
      claims.exp > now - CLOCK_SKEW_SECONDS &&
      (claims.nbf === undefined || claims.nbf <= now + CLOCK_SKEW_SECONDS) &&
      sameEmail(claims.email, config.email)
    )
  } catch {
    return false
  }
}

/**
 * `null` when the request may proceed, otherwise the response to send.
 *
 * Fails closed: a Worker with no Access configuration rejects everything
 * rather than serving unprotected. `alchemy dev` is the one exception — its
 * `ALCHEMY_DEV_ACCESS` stand-in carries an identity instead of a JWT, and the
 * binding only ever exists locally.
 */
export const checkAccess = async (request: Request, env: AccessEnv): Promise<Response | null> => {
  const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud, ALLOWED_EMAIL: email } = env
  if (email === undefined || email === '')
    return new Response('Access not configured', { status: 500 })

  const dev = env.ALCHEMY_DEV_ACCESS
  if (dev !== undefined) {
    return sameEmail(dev.identity?.email, email) ? null : new Response('Forbidden', { status: 403 })
  }

  if (!teamDomain || !aud) return new Response('Access not configured', { status: 500 })
  const token = request.headers.get('cf-access-jwt-assertion')
  if (token === null) return new Response('Forbidden', { status: 403 })
  return (await verifyAccessJwt(token, { teamDomain, aud, email }))
    ? null
    : new Response('Forbidden', { status: 403 })
}
