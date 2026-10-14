import { describe, expect, it } from 'vitest'
import { isAccessAuthenticationFailure } from '../src/lib/rpc'

const appOrigin = 'https://nook.example.com'
const rpcUrl = `${appOrigin}/api/rpc`

describe('RPC authentication recovery', () => {
  it('does not restart the app for a normal RPC response', () => {
    expect(isAccessAuthenticationFailure(rpcUrl, rpcUrl, 200, appOrigin)).toBe(false)
  })

  it.each([401, 403])('restarts the app for an Access rejection (%i)', (status) => {
    expect(isAccessAuthenticationFailure(rpcUrl, rpcUrl, status, appOrigin)).toBe(true)
  })

  it('restarts the app when Access redirects the RPC request to its login page', () => {
    expect(
      isAccessAuthenticationFailure(
        rpcUrl,
        `${appOrigin}/cdn-cgi/access/login/nook?token=expired`,
        200,
        appOrigin,
      ),
    ).toBe(true)
  })

  it('restarts the app when Access redirects to an external identity provider', () => {
    expect(
      isAccessAuthenticationFailure(
        '/api/rpc',
        'https://identity.example.net/login',
        200,
        appOrigin,
      ),
    ).toBe(true)
  })

  it('does not treat an unknown response URL as an authentication redirect', () => {
    expect(isAccessAuthenticationFailure('/api/rpc', '', 200, appOrigin)).toBe(false)
  })
})
