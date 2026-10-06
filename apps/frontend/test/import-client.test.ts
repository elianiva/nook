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
import { ImportProgress } from '../src/lib/import-worker-protocol'
import { Message } from '../src/app/model'
import { toMessages } from '../src/app/subscriptions'

const ID = 'a'.repeat(64)
const blob = new Blob(['hello'])

const some = <A>(option: Option.Option<A>): A => {
  if (Option.isNone(option)) throw new Error('expected Some')
  return option.value
}

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
