import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import type { RestoreResult } from '@nook/api'
import { Message, seedModel } from '../src/app/model'
import { update } from '../src/app/update'
import { names, url, some } from './helpers'

const counts = { decks: 1, noteTypes: 0, notes: 2, cards: 3, reviews: 4 }
const result = (dryRun: boolean): RestoreResult => ({
  dryRun,
  version: 2,
  exportedAt: '2026-01-01T00:00:00.000Z',
  added: counts,
  existing: { decks: 0, noteTypes: 0, notes: 0, cards: 0, reviews: 0 },
  schedulesUpdated: 0,
})

describe('restore flow', () => {
  it('previews with a dry run, writes only after confirming, then refreshes lists', () => {
    const start = seedModel(url('/settings'))
    const picked = update(start, Message.GotRestoreFile({ filename: 'b.json', json: '{}' }))
    expect(picked.model.restore.phase).toBe('reading')
    expect(names(picked)).toEqual(['RestoreCollection'])
    expect(picked.commands?.[0]?.args).toEqual({ json: '{}', dryRun: true })

    const previewed = update(picked.model, Message.PreviewedRestore({ result: result(true) }))
    expect(previewed.model.restore.phase).toBe('preview')
    expect(previewed.commands ?? []).toEqual([])

    const confirmed = update(previewed.model, Message.ClickedConfirmRestore())
    expect(confirmed.model.restore.phase).toBe('restoring')
    expect(confirmed.commands?.[0]?.args).toEqual({ json: '{}', dryRun: false })

    const done = update(confirmed.model, Message.RestoredCollection({ result: result(false) }))
    expect(done.model.restore.phase).toBe('done')
    expect(done.model.restore.json).toBe('')
    expect(some(done.model.restore.result).added.reviews).toBe(4)
  })

  it('does not write when confirm arrives outside the preview', () => {
    const idle = update(seedModel(url('/settings')), Message.ClickedConfirmRestore())
    expect(idle.commands ?? []).toEqual([])
  })

  it('keeps the server issues on failure and clears them on dismiss', () => {
    const failed = update(
      seedModel(url('/settings')),
      Message.RestoreFailed({ error: 'Not valid', issues: ['Card "c" is in Deck "x"'] }),
    )
    expect(failed.model.restore.phase).toBe('failed')
    expect(failed.model.restore.issues).toEqual(['Card "c" is in Deck "x"'])
    expect(Option.isSome(failed.model.restore.error)).toBe(true)
    const dismissed = update(failed.model, Message.ClickedDismissRestore())
    expect(dismissed.model.restore.phase).toBe('idle')
  })
})
