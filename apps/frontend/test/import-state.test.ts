/**
 * The Import state machine, as `update` moves it.
 *
 * These transitions are the whole of the durable client Import: which Message
 * starts the worker, which one keeps it alive, which one ends it, and which one
 * forgets the archive. They are pure, so they are tested without a browser.
 */

import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import type { Url } from 'foldkit/url'
import { ImportId } from '@nook/api'
import { Message, idleImport, seedModel } from '../src/app/model'
import type { Model } from '../src/app/model'
import { init, update } from '../src/app/update'

const ID = ImportId.make('a'.repeat(64))

const url = (pathname: string): Url => ({
  protocol: 'http:',
  host: 'localhost',
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
})

const decksModel = (): Model => seedModel(url('/decks'))

const progress = {
  notesImported: 2,
  cardsImported: 2,
  noteCount: 2,
  cardCount: 2,
  mediaCount: 1,
}

/** The value inside a `Some`, or a thrown error when the Option is empty. */
const some = <A>(option: Option.Option<A>): A => {
  if (Option.isNone(option)) throw new Error('expected Some')
  return option.value
}

const names = (result: {
  readonly commands?: ReadonlyArray<{ readonly name: string }>
}): string[] => (result.commands ?? []).map((command) => command.name)

/** A Model whose Import has started, which is the state most cases move from. */
const running = (): Model =>
  update(decksModel(), Message.GotImportFile({ id: ID, filename: 'japanese.apkg' })).model

describe('Import state', () => {
  it('starts the worker when a file is picked', () => {
    const { model } = update(decksModel(), Message.GotImportFile({ id: ID, filename: 'x.apkg' }))
    expect(some(model.importState.id)).toBe(ID)
    expect(model.importState.filename).toBe('x.apkg')
    expect(model.importState.active).toBe(true)
    expect(model.importState.phase).toBe('running')
  })

  it('shows preparing, with no worker, while the picker is open', () => {
    const result = update(decksModel(), Message.ClickedImport())
    expect(result.model.importState.phase).toBe('preparing')
    expect(result.model.importState.active).toBe(false)
    expect(names(result)).toEqual(['PrepareImport'])
  })

  it('resets when the picker is cancelled', () => {
    const preparing = update(decksModel(), Message.ClickedImport()).model
    const { model } = update(preparing, Message.CancelledImportSelect())
    expect(model.importState).toEqual(idleImport)
  })

  it('keeps the worker alive as the phase moves', () => {
    const reading = update(running(), Message.ImportWorkerPhase({ phase: 'reading' })).model
    const writing = update(reading, Message.ImportWorkerPhase({ phase: 'writing' })).model
    expect(reading.importState.active).toBe(true)
    expect(writing.importState.phase).toBe('writing')
    expect(writing.importState.active).toBe(true)
  })

  it('records the counts the worker reports', () => {
    const { model } = update(running(), Message.ReportedImport({ progress }))
    expect(some(model.importState.status).notesImported).toBe(2)
    expect(model.importState.active).toBe(true)
  })

  it('finishes, forgets the archive, and refetches the decks', () => {
    const result = update(running(), Message.CompletedImport({ progress }))
    expect(result.model.importState.phase).toBe('done')
    expect(result.model.importState.active).toBe(false)
    expect(Option.isNone(result.model.importState.id)).toBe(true)
    expect(some(result.model.importState.status).cardsImported).toBe(2)
    expect(names(result)).toEqual(['FetchDecks', 'ClearImportJob'])
  })

  it('keeps the archive and the id when a run fails', () => {
    const { model } = update(running(), Message.FailedImport({ error: 'The network dropped.' }))
    expect(model.importState.phase).toBe('failed')
    expect(model.importState.active).toBe(false)
    expect(Option.isSome(model.importState.id)).toBe(true)
    expect(some(model.importState.error)).toBe('The network dropped.')
  })

  it('retries a failed run without another file pick', () => {
    const failed = update(running(), Message.FailedImport({ error: 'boom' })).model
    const { model } = update(failed, Message.ClickedRetryImport())
    expect(model.importState.active).toBe(true)
    expect(model.importState.phase).toBe('running')
    expect(Option.isNone(model.importState.error)).toBe(true)
    expect(some(model.importState.id)).toBe(ID)
  })

  it('cancels a running run and forgets the archive', () => {
    const result = update(running(), Message.ClickedCancelImport())
    expect(result.model.importState).toEqual(idleImport)
    expect(names(result)).toEqual(['ClearImportJob'])
  })

  it('dismisses a finished run', () => {
    const done = update(running(), Message.CompletedImport({ progress })).model
    const result = update(done, Message.ClickedDismissImport())
    expect(result.model.importState).toEqual(idleImport)
    expect(names(result)).toEqual(['ClearImportJob'])
  })

  it('resumes a kept archive on boot', () => {
    const { model } = update(
      decksModel(),
      Message.RestoredImportJob({ job: Option.some({ id: ID, filename: 'x.apkg' }) }),
    )
    expect(model.importState.active).toBe(true)
    expect(model.importState.phase).toBe('running')
    expect(some(model.importState.id)).toBe(ID)
  })

  it('does nothing when boot finds no kept archive', () => {
    const before = decksModel()
    const { model } = update(before, Message.RestoredImportJob({ job: Option.none() }))
    expect(model.importState).toEqual(before.importState)
  })

  it('restores a kept archive on every boot', () => {
    expect(names(init(url('/decks')))).toEqual(['FetchDecks', 'RestoreImportJob'])
  })
})
