import { describe, expect, it } from 'vitest'
import { getAccessAuthenticationAction } from '../src/lib/rpc'

const appOrigin = 'https://nook.example.com'
const rpcUrl = `${appOrigin}/api/rpc`

describe('RPC authentication recovery', () => {
  it('does nothing for a normal RPC response', () => {
    expect(getAccessAuthenticationAction(rpcUrl, rpcUrl, 200, appOrigin)).toBeNull()
  })

  it.each([401, 403])('reloads the app for an Access rejection (%i)', (status) => {
    expect(getAccessAuthenticationAction(rpcUrl, rpcUrl, status, appOrigin)).toEqual({
      _tag: 'reload',
    })
  })

  it('navigates to the Access login page when the RPC request is redirected', () => {
    expect(
      getAccessAuthenticationAction(
        rpcUrl,
        `${appOrigin}/cdn-cgi/access/login/nook?token=expired`,
        200,
        appOrigin,
      ),
    ).toEqual({
      _tag: 'redirect',
      url: `${appOrigin}/cdn-cgi/access/login/nook?token=expired`,
    })
  })

  it('navigates to an external identity provider when Access redirects there', () => {
    expect(
      getAccessAuthenticationAction(
        '/api/rpc',
        'https://identity.example.net/login',
        200,
        appOrigin,
      ),
    ).toEqual({ _tag: 'redirect', url: 'https://identity.example.net/login' })
  })

  it('does nothing when the response URL is unknown', () => {
    expect(getAccessAuthenticationAction('/api/rpc', '', 200, appOrigin)).toBeNull()
  })
})
