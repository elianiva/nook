/**
 * The Import's client-side boundaries: the value IndexedDB hands back, the
 * worker events as Messages, and the progress shape a `postMessage` carries.
 *
 * IndexedDB and the worker are outside the program, so their values are checked
 * where they enter rather than trusted.
 */

import { describe, expect, it } from 'vitest'
import { Option, Schema } from 'effect'
import { ImportId } from '@nook/api'
import { decodeImportJob } from '../src/lib/import-jobs'
import { ImportPreview, ImportProgress } from '../src/lib/import-worker-protocol'
import { Message } from '../src/app/model'
import { toMessages } from '../src/app/subscriptions'
import { some } from './helpers'

const ID = 'a'.repeat(64)
const blob = new Blob(['hello'])

describe('decodeImportJob', () => {
  it('reads a stored job', () => {
    const decoded = some(
      decodeImportJob({ id: ID, filename: 'x.apkg', byteLength: 12, createdAt: 5, blob }),
    )
    expect(decoded.id).toBe(ImportId.make(ID))
    expect(decoded.filename).toBe('x.apkg')
    expect(decoded.byteLength).toBe(12)
    expect(decoded.createdAt).toBe(5)
  })

  it('fills a missing size and time from the blob', () => {
    const decoded = some(decodeImportJob({ id: ID, filename: 'x.apkg', blob }))
    expect(decoded.byteLength).toBe(blob.size)
    expect(decoded.createdAt).toBe(0)
  })

  it.each([
    null,
    undefined,
    42,
    'text',
    {},
    { id: ID, filename: 'x.apkg' },
    { id: 1, filename: 'x.apkg', blob },
    { id: ID, filename: 2, blob },
    { id: ID, filename: 'x.apkg', blob: 'not a blob' },
  ])('rejects %p', (value) => {
    expect(Option.isNone(decodeImportJob(value))).toBe(true)
  })
})

describe('worker events as Messages', () => {
  it('maps a phase event', () => {
    expect(toMessages({ type: 'phase', phase: 'reading' })).toEqual([
      Message.ImportWorkerPhase({ phase: 'reading' }),
    ])
  })

  it('maps a read stage event', () => {
    expect(toMessages({ type: 'readStage', stage: 'collection' })).toEqual([
      Message.ReportedImportReadStage({ stage: 'collection' }),
    ])
  })

  it('maps a preview event', () => {
    const preview = {
      schemaVersion: 18,
      noteCount: 4,
      cardCount: 4,
      mediaCount: 2,
      mediaBytes: 2048,
      decks: [{ id: 7, name: 'Japanese::Core' }],
      noteTypes: [{ id: 100, name: 'Basic', kind: 'normal' as const, templateCount: 1 }],
    }
    expect(toMessages({ type: 'preview', preview })).toEqual([
      Message.GotImportPreview({ preview }),
    ])
  })

  it('maps a progress event', () => {
    const progress = {
      notesImported: 2,
      cardsImported: 1,
      mediaImported: 0,
      noteCount: 4,
      cardCount: 4,
      mediaCount: 0,
    }
    expect(toMessages({ type: 'progress', progress })).toEqual([
      Message.ReportedImport({ progress }),
    ])
  })

  it('maps a done event', () => {
    const progress = {
      notesImported: 4,
      cardsImported: 4,
      mediaImported: 0,
      noteCount: 4,
      cardCount: 4,
      mediaCount: 0,
    }
    expect(toMessages({ type: 'done', progress })).toEqual([Message.CompletedImport({ progress })])
  })

  it('maps a failed event', () => {
    expect(toMessages({ type: 'failed', error: 'boom' })).toEqual([
      Message.FailedImport({ error: 'boom' }),
    ])
  })
})

describe('ImportPreview', () => {
  it('decodes the plain object a postMessage delivers', () => {
    // An Effect Option would arrive empty, which is why the preview is plain data.
    const plain = {
      schemaVersion: 18,
      noteCount: 4,
      cardCount: 4,
      mediaCount: 2,
      mediaBytes: 2048,
      decks: [{ id: 7, name: 'Japanese::Core' }],
      noteTypes: [{ id: 100, name: 'Basic', kind: 'normal', templateCount: 1 }],
    }
    expect(Schema.decodeUnknownSync(ImportPreview)(plain)).toEqual(plain)
  })
})

describe('ImportProgress', () => {
  it('decodes the plain object a postMessage delivers', () => {
    // An Effect Option would arrive empty, which is why progress is plain data.
    const plain = {
      notesImported: 1,
      cardsImported: 2,
      mediaImported: 3,
      noteCount: 3,
      cardCount: 4,
      mediaCount: 5,
    }
    expect(Schema.decodeUnknownSync(ImportProgress)(plain)).toEqual(plain)
  })
})

describe('importRun subscription lifetime', () => {
  it('keeps one worker across the run phases and media toggles', async () => {
    const { subscriptions } = await import('../src/app/subscriptions')
    const entry = (
      subscriptions as unknown as Record<
        string,
        {
          readonly keepAliveEquivalence?: (left: unknown, right: unknown) => boolean
          readonly modelToDependencies: (model: unknown) => unknown
        }
      >
    ).importRun
    if (entry === undefined) throw new Error('expected an importRun subscription')
    // The worker reports these phases itself as it opens the archive and then
    // writes rows. Restarting on them tears the worker down mid-run, and each
    // replacement starts by posting `reading` again: the panel loops on
    // counting and reading instead of finishing.
    const equivalence = entry.keepAliveEquivalence
    if (typeof equivalence !== 'function') throw new Error('expected keepAliveEquivalence')
    const { Option } = await import('effect')
    const base = {
      importId: Option.some('a'.repeat(64)),
      active: true,
      phase: 'running' as const,
      hasPreview: false,
      includeMedia: true,
    }
    // The worker's own progress must not restart it.
    expect(equivalence(base, { ...base, phase: 'reading' })).toBe(true)
    expect(equivalence({ ...base, phase: 'reading' }, { ...base, phase: 'writing' })).toBe(true)
    // A Media toggle must not restart the run worker.
    expect(equivalence(base, { ...base, includeMedia: false })).toBe(true)
    // A real transition restarts: preview swaps its worker for the run one.
    expect(equivalence({ ...base, phase: 'preview' }, base)).toBe(false)
    // An end state tears the worker down.
    expect(equivalence(base, { ...base, active: false })).toBe(false)
    expect(equivalence(base, { ...base, phase: 'done' })).toBe(false)
  })
})
