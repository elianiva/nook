/**
 * The Import state machine, as `update` moves it.
 *
 * These transitions are the whole of the durable client Import: which Message
 * starts the worker, which one keeps it alive, which one ends it, and which one
 * forgets the archive. They are pure, so they are tested without a browser.
 */

import { describe, expect, it } from '@effect/vitest'
import { Arbitrary, Option, Schema } from 'effect'
import { ImportId } from '@nook/api'
import { Message, idleImport, seedModel } from '../src/app/model'
import type { Model } from '../src/app/model'
import { init, update } from '../src/app/update'
import { ImportPreview, ImportProgress } from '../src/lib/import-worker-protocol'
import { names, some, url } from './helpers'

const ID = ImportId.make('a'.repeat(64))
const importId = Arbitrary.schema(ImportId)
const text = Arbitrary.schema(Schema.String)
const previewValue = Arbitrary.schema(ImportPreview)
const progressValue = Arbitrary.schema(ImportProgress)

const decksModel = (): Model => seedModel(url('/decks'))

const progress = {
  notesImported: 2,
  cardsImported: 2,
  mediaImported: 0,
  noteCount: 2,
  cardCount: 2,
  mediaCount: 1,
}

/** A Model whose Import file is picked: the detail panel shows, nothing runs yet. */
const picked = (): Model =>
  update(decksModel(), Message.GotImportFile({ id: ID, filename: 'japanese.apkg' })).model

const preview = {
  schemaVersion: 18,
  noteCount: 2,
  cardCount: 2,
  mediaCount: 1,
  mediaBytes: 2048,
  decks: [{ id: 7, name: 'Japanese::Core' }],
  noteTypes: [{ id: 100, name: 'Basic', kind: 'normal' as const, templateCount: 1 }],
}

/** A Model whose detail panel has its preview: Start is available. */
const previewed = (): Model => update(picked(), Message.GotImportPreview({ preview })).model

/** A Model whose Import has started, which is the state most cases move from. */
const running = (): Model => update(previewed(), Message.ClickedStartImport()).model

describe('Import state', () => {
  it.prop('opens the detail panel for any picked archive', [importId, text], ([id, filename]) => {
    const { model } = update(decksModel(), Message.GotImportFile({ id, filename }))
    expect(some(model.importState.id)).toBe(id)
    expect(model.importState.filename).toBe(filename)
    expect(model.importState.phase).toBe('preview')
    expect(model.importState.active).toBe(true)
    expect(Option.isNone(model.importState.preview)).toBe(true)
    expect(model.importState.includeMedia).toBe(true)
  })

  it.prop('lands any preview without starting the run', [previewValue], ([preview]) => {
    const { model } = update(picked(), Message.GotImportPreview({ preview }))
    expect(model.importState.phase).toBe('preview')
    expect(model.importState.active).toBe(false)
    expect(some(model.importState.preview)).toEqual(preview)
    expect(Option.isNone(model.importState.error)).toBe(true)
  })

  it.prop(
    'sets the selected media choice on the detail panel',
    [Arbitrary.schema(Schema.Boolean)],
    ([isChecked]) => {
      const { model } = update(previewed(), Message.ToggledImportMedia({ isChecked }))
      expect(model.importState.includeMedia).toBe(isChecked)
      expect(model.importState.phase).toBe('preview')
    },
  )

  it.prop('records any progress the worker reports', [progressValue], ([progress]) => {
    const { model } = update(running(), Message.ReportedImport({ progress }))
    expect(some(model.importState.status)).toEqual(progress)
    expect(model.importState.active).toBe(true)
  })

  it('starts the run from the detail panel', () => {
    const { model } = update(previewed(), Message.ClickedStartImport())
    expect(model.importState.phase).toBe('running')
    expect(model.importState.active).toBe(true)
    expect(some(model.importState.id)).toBe(ID)
  })

  it('ignores Start outside the detail panel', () => {
    const { model } = update(decksModel(), Message.ClickedStartImport())
    expect(model.importState).toEqual(idleImport)
  })

  it('keeps the detail panel when the preview read fails', () => {
    const { model } = update(picked(), Message.FailedImport({ error: 'That file is damaged.' }))
    expect(model.importState.phase).toBe('preview')
    expect(model.importState.active).toBe(false)
    expect(some(model.importState.error)).toBe('That file is damaged.')
    expect(Option.isSome(model.importState.id)).toBe(true)
  })

  it('retries a failed preview read without another file pick', () => {
    const failed = update(picked(), Message.FailedImport({ error: 'boom' })).model
    const { model } = update(failed, Message.ClickedRetryImport())
    expect(model.importState.phase).toBe('preview')
    expect(model.importState.active).toBe(true)
    expect(Option.isNone(model.importState.error)).toBe(true)
    expect(some(model.importState.id)).toBe(ID)
  })

  it('pressing Import runs the picker with no panel behind it', () => {
    const result = update(decksModel(), Message.ClickedImport())
    expect(result.model.importState).toEqual(idleImport)
    expect(names(result)).toEqual(['PrepareImport'])
  })

  it('cancelling the picker leaves no panel', () => {
    const { model } = update(decksModel(), Message.CancelledImportSelect())
    expect(model.importState).toEqual(idleImport)
  })

  it('keeps the worker alive as the phase moves', () => {
    const reading = update(running(), Message.ImportWorkerPhase({ phase: 'reading' })).model
    const writing = update(reading, Message.ImportWorkerPhase({ phase: 'writing' })).model
    expect(reading.importState.active).toBe(true)
    expect(writing.importState.phase).toBe('writing')
    expect(writing.importState.active).toBe(true)
  })

  it('names each step of the read while the archive opens', () => {
    const reading = update(running(), Message.ImportWorkerPhase({ phase: 'reading' })).model
    expect(Option.isNone(reading.importState.readStage)).toBe(true)
    const listing = update(reading, Message.ReportedImportReadStage({ stage: 'listing' })).model
    expect(some(listing.importState.readStage)).toBe('listing')
    const writing = update(listing, Message.ImportWorkerPhase({ phase: 'writing' })).model
    expect(Option.isNone(writing.importState.readStage)).toBe(true)
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
    expect(failed.importState.phase).toBe('failed')
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

  it('resumes a kept archive on boot, past the detail panel', () => {
    const { model } = update(
      decksModel(),
      Message.RestoredImportJob({ job: Option.some({ id: ID, filename: 'x.apkg' }) }),
    )
    expect(model.importState.active).toBe(true)
    expect(model.importState.phase).toBe('running')
    expect(some(model.importState.id)).toBe(ID)
    expect(Option.isNone(model.importState.preview)).toBe(true)
  })

  it('does nothing when boot finds no kept archive', () => {
    const before = decksModel()
    const { model } = update(before, Message.RestoredImportJob({ job: Option.none() }))
    expect(model.importState).toEqual(before.importState)
  })

  it('restores a kept archive on every boot', () => {
    expect(names(init(url('/decks')))).toEqual(['FetchDecks', 'RestoreImportJob', 'RestoreQueries'])
  })
})
