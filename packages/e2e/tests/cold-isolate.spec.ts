import { expect, test } from '@playwright/test'

// Runs before `smoke.spec.ts` (files run alphabetically) against a cold isolate:
// Playwright probes an asset, so nothing has reached the Worker yet. A handler
// cached across requests hangs here and fails every RPC call after the probe.
test('an RPC call succeeds after a non-RPC first request to the Worker', async ({ request }) => {
  const health = await request.get('/api/health')
  expect(health.status()).toBe(200)

  const rpc = await request.post('/api/rpc', {
    data: { _tag: 'Request', id: '1', tag: 'decksList', payload: {}, headers: [] },
  })
  expect(rpc.status()).toBe(200)
  expect(await rpc.text()).toContain('"_tag":"Success"')
})
