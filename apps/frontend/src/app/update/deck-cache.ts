/**
 * Optimistic edits to the cached deck list and deck detail, and their rollback.
 */

import { HashMap, Option } from 'effect'
import { AsyncData } from 'foldkit'
import type { DeckDetail, DeckId, DeckSummary } from '@nook/api'
import type { DeckCacheSnapshot } from '../model'
import type { Model } from '../model'
import { deckDetailQuery, decksQuery } from '../queries'

export const deckDetailKey = (deckId: DeckId): string => JSON.stringify({ deckId })

export const deckCacheSnapshot = (model: Model, deckId: DeckId) => ({
  deckId,
  summaries: AsyncData.getData(decksQuery.read(model.decks)),
  detail: AsyncData.getData(deckDetailQuery.read(model.deckDetail, { deckId })),
})

/** Applies one optimistic summary edit to every loaded cache for this deck. */
export const updateDeckCache = (
  model: Model,
  deckId: DeckId,
  updateSummary: (summary: DeckSummary) => DeckSummary,
): Model => {
  const summaryMatches = (summary: DeckSummary): DeckSummary =>
    summary.id === deckId ? updateSummary(summary) : summary
  const summaries = AsyncData.map(model.decks.data, (rows) => rows.map(summaryMatches))
  const key = deckDetailKey(deckId)
  const entry = HashMap.get(model.deckDetail.entries, key)
  const detailModel = Option.match(entry, {
    onNone: () => model.deckDetail,
    onSome: (cached) => ({
      ...model.deckDetail,
      entries: HashMap.set(model.deckDetail.entries, key, {
        ...cached,
        data: AsyncData.map(cached.data, (detail: DeckDetail) => ({
          ...detail,
          summary: updateSummary(detail.summary),
        })),
      }),
    }),
  })
  return {
    ...model,
    decks: { ...model.decks, data: summaries },
    deckDetail: detailModel,
  }
}

/** Rolls an optimistic cache edit back to its server values after failure. */
export const restoreDeckCache = (model: Model, snapshot: DeckCacheSnapshot): Model => {
  let restored = model
  if (Option.isSome(snapshot.summaries)) {
    restored = {
      ...restored,
      decks: { ...restored.decks, data: AsyncData.succeed(snapshot.summaries.value) },
    }
  }
  if (Option.isSome(snapshot.detail)) {
    const key = deckDetailKey(snapshot.deckId)
    const entry = HashMap.get(restored.deckDetail.entries, key)
    if (Option.isSome(entry)) {
      restored = {
        ...restored,
        deckDetail: {
          ...restored.deckDetail,
          entries: HashMap.set(restored.deckDetail.entries, key, {
            ...entry.value,
            data: AsyncData.succeed(snapshot.detail.value),
          }),
        },
      }
    }
  }
  return restored
}
