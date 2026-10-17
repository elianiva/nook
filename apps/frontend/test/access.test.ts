import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { checkAccess } from '../src/lib/access'

const teamDomain = 'team.cloudflareaccess.com'
const aud = 'app-aud'
const email = 'me@example.com'

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

let signingKey: CryptoKey
let jwks: { keys: JsonWebKey[] }

const sign = async (
  claims: Record<string, unknown>,
  { kid = 'k1', key = signingKey }: { kid?: string; key?: CryptoKey } = {},
): Promise<string> => {
  const unsigned = `${encode({ alg: 'RS256', kid })}.${encode(claims)}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  )
  return `${unsigned}.${Buffer.from(signature).toString('base64url')}`
}

const validClaims = () => ({
  iss: `https://${teamDomain}`,
  aud: [aud],
  email,
  exp: Math.floor(Date.now() / 1000) + 600,
})

const generate = () =>
  crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )

beforeAll(async () => {
  const pair = await generate()
  signingKey = pair.privateKey
  jwks = {
    keys: [{ ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' } as JsonWebKey],
  }
})

afterEach(() => vi.unstubAllGlobals())

const env = { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud, ALLOWED_EMAIL: email }
const request = (token?: string) =>
  new Request('https://nook.example.com/api/rpc', {
    headers: token === undefined ? {} : { 'cf-access-jwt-assertion': token },
  })
const stubJwks = () => {
  const fetchMock = vi.fn(async () => Response.json(jwks))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('checkAccess', () => {
  it('admits a valid token', async () => {
    stubJwks()
    expect(await checkAccess(request(await sign(validClaims())), env)).toBeNull()
  })

  it('matches the email case-insensitively and accepts a string audience', async () => {
    stubJwks()
    const token = await sign({ ...validClaims(), aud: aud, email: 'Me@Example.com' })
    expect(await checkAccess(request(token), env)).toBeNull()
  })

  it('rejects a missing token', async () => {
    expect((await checkAccess(request(), env))?.status).toBe(403)
  })

  it.each([
    ['wrong audience', { aud: ['other'] }],
    ['wrong email', { email: 'stranger@example.com' }],
    ['no email', { email: undefined }],
    ['wrong issuer', { iss: 'https://evil.cloudflareaccess.com' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['no expiry', { exp: undefined }],
  ])('rejects a token with %s', async (_name, override) => {
    stubJwks()
    const token = await sign({ ...validClaims(), ...override })
    expect((await checkAccess(request(token), env))?.status).toBe(403)
  })

  it('rejects a token signed by a different key', async () => {
    stubJwks()
    const other = await generate()
    const token = await sign(validClaims(), { key: other.privateKey })
    expect((await checkAccess(request(token), env))?.status).toBe(403)
  })

  it('rejects an unknown kid and malformed tokens', async () => {
    stubJwks()
    expect(
      (await checkAccess(request(await sign(validClaims(), { kid: 'nope' })), env))?.status,
    ).toBe(403)
    expect((await checkAccess(request('not.a.jwt'), env))?.status).toBe(403)
    expect((await checkAccess(request('garbage'), env))?.status).toBe(403)
  })

  it('rejects an alg=none token', async () => {
    stubJwks()
    const token = `${encode({ alg: 'none', kid: 'k1' })}.${encode(validClaims())}.`
    expect((await checkAccess(request(token), env))?.status).toBe(403)
  })

  it('fails closed when Access is not configured', async () => {
    expect((await checkAccess(request(), { ALLOWED_EMAIL: email }))?.status).toBe(500)
    expect((await checkAccess(request(), {}))?.status).toBe(500)
    const missing = await checkAccess(request(), { ALLOWED_EMAIL: email, ACCESS_AUD: aud })
    expect(await missing?.text()).toContain('NOOK_ACCESS_TEAM_DOMAIN is not set')
  })

  it('trusts the dev stand-in only for the allowed email', async () => {
    const dev = (identityEmail: string) => ({
      ALLOWED_EMAIL: email,
      ALCHEMY_DEV_ACCESS: { aud: 'dev', identity: { email: identityEmail } },
    })
    expect(await checkAccess(request(), dev(email))).toBeNull()
    expect((await checkAccess(request(), dev('stranger@example.com')))?.status).toBe(403)
  })
})
