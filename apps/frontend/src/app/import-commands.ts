/**
 * Import Commands: the parts of an Import that touch the browser but not the
 * archive's contents.
 *
 * The reading lives in the Import worker (`src/import-worker.ts`), which the
 * subscription starts. These Commands do the three things around it: pick an
 * archive and keep it in IndexedDB, find a kept archive on boot, and drop one
 * when the Import is over.
 *
 * `PrepareImport` hashes the file and keeps it under that hash. The hash is the
 * Import's id in D1, so the same archive always lands on the same Import, and a
 * run that stops midway resumes from the cursors D1 holds instead of starting
 * over. Failure is a Message, never a thrown error.
 */

import { Effect, Option } from 'effect'
import { Command, File } from 'foldkit'
import { ImportId } from '@nook/api'
import { toHex } from '@nook/anki'
import { clearImportJob, loadImportJob, saveImportJob } from '@/lib/import-jobs'
import { Message } from './model'

export const PrepareImport = Command.define('PrepareImport', {
  messages: [Message.GotImportFile, Message.CancelledImportSelect, Message.FailedImport],
  execute: Effect.gen(function* () {
    const picked = yield* File.select(['.apkg'])
    if (Option.isNone(picked)) return Message.CancelledImportSelect()
    const file = picked.value
    const filename = File.name(file)

    const read = yield* File.readAsArrayBuffer(file).pipe(Effect.result)
    if (read._tag === 'Failure') {
      return Message.FailedImport({ error: 'Could not read that file. Pick it again.' })
    }

    const digest = yield* Effect.promise(() => crypto.subtle.digest('SHA-256', read.success))
    const id = ImportId.make(toHex(new Uint8Array(digest)))

    // Keep the archive before the run starts, so a reload can resume it. The
    // browser may refuse or later evict the record; both are recoverable by
    // picking the file again, so the Import still runs either way.
    const kept = yield* saveImportJob({
      id,
      filename,
      byteLength: File.size(file),
      createdAt: Date.now(),
      blob: file,
    }).pipe(Effect.result)
    if (kept._tag === 'Failure') {
      return Message.FailedImport({
        error: 'Could not keep that file for the import. Check browser storage and try again.',
      })
    }

    return Message.GotImportFile({ id, filename })
  }),
})

/** Reads the kept archive on boot, so a run interrupted by a reload resumes. */
export const RestoreImportJob = Command.define('RestoreImportJob', {
  messages: [Message.RestoredImportJob],
  execute: loadImportJob().pipe(
    Effect.map((job) =>
      Message.RestoredImportJob({
        job: Option.map(job, (kept) => ({ id: kept.id, filename: kept.filename })),
      }),
    ),
    Effect.catch(() => Effect.succeed(Message.RestoredImportJob({ job: Option.none() }))),
  ),
})

/** Drops the kept archive once the Import is done or dismissed. */
export const ClearImportJob = Command.define('ClearImportJob', {
  messages: [Message.ClearedImportJob],
  execute: clearImportJob().pipe(
    Effect.as(Message.ClearedImportJob()),
    Effect.catch(() => Effect.succeed(Message.ClearedImportJob())),
  ),
})
