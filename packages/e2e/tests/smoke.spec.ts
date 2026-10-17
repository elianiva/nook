import { expect, test } from '@playwright/test'
import { CARDS, DECK_NAME, buildApkg } from '../support/apkg'

test('import, review, grade offline, and sync on reconnect', async ({ page, context }) => {
  // 1. Import a three-Card deck.
  await page.goto('/decks')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import a deck…' }).click()
  await (
    await chooser
  ).setFiles({
    name: 'smoke.apkg',
    mimeType: 'application/octet-stream',
    buffer: await buildApkg(),
  })
  await page.getByRole('button', { name: 'Start import' }).click()
  await expect(page.getByText('Imported smoke.apkg')).toBeVisible()

  // The collection ships with showcase decks, so review only the imported one.
  const deckLink = page.getByRole('link', { name: new RegExp(DECK_NAME) })
  await expect(deckLink).toBeVisible()
  const deckId = (await deckLink.getAttribute('href'))?.split('/').at(-1)
  expect(deckId).toBeTruthy()
  const reviewUrl = `/review/${deckId}`

  // 2. Review the first Card online.
  await page.goto(reviewUrl)
  await expect(page.getByText(`Card 1 of ${CARDS.length}`)).toBeVisible()
  await expect(page.getByText('Checking today’s queue…')).toBeHidden()
  await expect(page.locator('#nook-card')).toContainText(CARDS[0].front)
  await page.getByRole('button', { name: 'Show answer' }).click()
  await expect(page.locator('#nook-card')).toContainText(CARDS[0].back)
  await page.getByRole('button', { name: 'Good' }).click()
  await expect(page.getByText('1 reviewed')).toBeVisible()

  // 3. Lose the network, then grade the rest from the prefetched queue
  //    (ADR 0001). Each grade lands at once and waits on the device.
  await context.setOffline(true)
  for (const [index, card] of CARDS.slice(1).entries()) {
    await expect(page.locator('#nook-card')).toContainText(card.front)
    await page.getByRole('button', { name: 'Show answer' }).click()
    await expect(page.locator('#nook-card')).toContainText(card.back)
    await page.getByRole('button', { name: 'Good' }).click()
    if (index === 0) await expect(page.getByText('1 offline')).toBeVisible()
  }
  await expect(page.getByText(/saved on this device/)).toBeVisible()

  // 4. Reconnect: the queued grades flush and the notice clears.
  await context.setOffline(false)
  await expect(page.getByText(/saved on this device/)).toBeHidden()
  await expect(page.getByText('Session complete')).toBeVisible()
  await expect(page.getByText(`You reviewed ${CARDS.length} Cards`)).toBeVisible()

  // 5. The server holds all three grades: a fresh load has nothing left due.
  await page.goto(reviewUrl)
  await expect(page.getByText('Nothing due')).toBeVisible()
})
