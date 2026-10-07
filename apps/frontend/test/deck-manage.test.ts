/**
 * The deck Manage transitions: rename draft, destructive confirms, and the
 * refreshes their answers trigger.
 *
 * These transitions are pure, so they are tested without a browser. The HTTP
 * itself lives behind an Effect the test never runs.
 */

import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import { CardId, DeckId } from '@nook/api'
import { Message, seedModel } from '../src/app/model'
import { init, update } from '../src/app/update'
import { names, url } from './helpers'

const deckId = DeckId.make('deck-a')

describe('deck manage', () => {
  it('seeds the rename draft from the deck summary', () => {
    const model = seedModel(url('/decks/deck-a'))
    const edited = update(
      model,
      Message.ClickedEditDeck({ deckId, name: 'Old', description: 'Words' }),
    ).model
    expect(edited.deckManage.editing).toBe(true)
    expect(edited.deckManage.name).toBe('Old')
    expect(edited.deckManage.description).toBe('Words')
    expect(edited.deckManage.deckId).toEqual(Option.some(deckId))
  })

  it('keeps a blank name on the device instead of sending it', () => {
    let model = update(
      seedModel(url('/decks/deck-a')),
      Message.ClickedEditDeck({ deckId, name: 'Old', description: '' }),
    ).model
    model = update(model, Message.TypedDeckName({ value: '   ' })).model
    const saved = update(model, Message.ClickedSaveDeck({ deckId }))
    expect(names(saved)).toEqual([])
    expect(Option.isSome(saved.model.deckManage.error)).toBe(true)
  })

  it('sends the trimmed rename and refreshes both reads when it lands', () => {
    let model = update(
      seedModel(url('/decks/deck-a')),
      Message.ClickedEditDeck({ deckId, name: 'Old', description: '' }),
    ).model
    model = update(model, Message.TypedDeckName({ value: '  New  ' })).model
    const saved = update(model, Message.ClickedSaveDeck({ deckId }))
    expect(names(saved)).toEqual(['RenameDeck'])
    expect(saved.model.deckManage.saving).toBe(true)

    const done = update(saved.model, Message.RenamedDeck({ deckId }))
    expect(done.model.deckManage.editing).toBe(false)
    expect(done.model.deckManage.saved).toBe(true)
    expect(names(done)).toEqual(['FetchDecks', 'FetchDeckDetail'])
  })

  it('opens one destructive confirm at a time and closes it on cancel', () => {
    let model = update(seedModel(url('/decks/deck-a')), Message.ClickedResetDeck({ deckId })).model
    expect(model.deckManage.confirming).toEqual(Option.some('reset'))

    model = update(model, Message.ClickedRemoveDeck({ deckId })).model
    expect(model.deckManage.confirming).toEqual(Option.some('remove'))
    expect(model.deckManage.editing).toBe(false)

    model = update(model, Message.ClickedCancelDeckConfirm()).model
    expect(model.deckManage.confirming).toEqual(Option.none())
  })

  it('sends the reset and refreshes both reads when it lands', () => {
    const model = update(
      seedModel(url('/decks/deck-a')),
      Message.ClickedResetDeck({ deckId }),
    ).model
    const confirmed = update(model, Message.ClickedConfirmResetDeck({ deckId }))
    expect(names(confirmed)).toEqual(['ResetDeck'])

    const done = update(confirmed.model, Message.ResetDeckDone({ deckId }))
    expect(done.model.deckManage.confirming).toEqual(Option.none())
    expect(names(done)).toEqual(['FetchDecks', 'FetchDeckDetail'])
  })

  it('sends the removal and leaves for the deck list when it lands', () => {
    const model = update(
      seedModel(url('/decks/deck-a')),
      Message.ClickedRemoveDeck({ deckId }),
    ).model
    const confirmed = update(model, Message.ClickedConfirmRemoveDeck({ deckId }))
    expect(names(confirmed)).toEqual(['RemoveDeck'])

    const done = update(confirmed.model, Message.RemovedDeck())
    expect(names(done)).toEqual(['NavigateToPath'])
  })

  it('shows a mutation failure in the manage section', () => {
    const model = update(
      seedModel(url('/decks/deck-a')),
      Message.DeckManageFailed({ error: 'offline' }),
    ).model
    expect(model.deckManage.error).toEqual(Option.some('offline'))
    expect(model.deckManage.saving).toBe(false)
  })

  it('offers a restore command for a suspended card', () => {
    const restored = update(
      seedModel(url('/decks/deck-a')),
      Message.ClickedRestoreCard({ cardId: CardId.make('card-a') }),
    )
    expect(names(restored)).toEqual(['SetCardSuspended'])
    expect(Option.isSome(restored.model.cardSuspensionPending)).toBe(true)
  })

  it('resets the manage draft when the route changes', () => {
    const edited = update(
      seedModel(url('/decks/deck-a')),
      Message.ClickedEditDeck({ deckId, name: 'Old', description: '' }),
    ).model
    const moved = update(edited, Message.ChangedUrl({ url: url('/decks') }))
    expect(moved.model.deckManage.editing).toBe(false)
    expect(moved.model.deckManage.name).toBe('')
  })

  it('starts the deck detail read on the deck page', () => {
    expect(names(init(url('/decks/deck-a')))).toContain('FetchDeckDetail')
  })
})
