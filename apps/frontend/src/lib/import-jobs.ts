/**
 * The durable side of an Import: the archive the browser is reading, kept in
 * IndexedDB.
 *
 * One Import runs at a time, so the store holds one record under a fixed key.
 * Keeping the archive here is what lets a reload resume a run: the app reads
 * the record back, hands the archive to the Import worker, and the worker
 * continues from the cursors D1 already holds. The record is deleted when the
 * run finishes or the Learner dismisses it.
 *
 * IndexedDB is the only durable state the client adds. D1 stays the source of
 * truth for how far an Import has come.
 */

import { Effect, Option } from 'effect'
import { ImportId } from '@nook/api'

const DB_NAME = 'nook'
const STORE_NAME = 'importJobs'
const ACTIVE_KEY = 'active'
const DB_VERSION = 4

/** The archive and its identity, as the store holds them. */
export interface StoredImportJob {
  readonly id: ImportId
  readonly filename: string
  readonly byteLength: number
  readonly createdAt: number
  readonly blob: Blob
}

/** The browser refused to read or write its own storage. */
export class ImportJobStoreUnavailable extends Error {
  readonly _tag = 'ImportJobStoreUnavailable'
}

/** Runs one request against the store and closes the database when it lands. */
const request = <A>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<A>,
): Effect.Effect<A, ImportJobStoreUnavailable> =>
  Effect.tryPromise({
    try: () =>
      new Promise<A>((resolve, reject) => {
        const open = indexedDB.open(DB_NAME, DB_VERSION)
        open.onupgradeneeded = () => {
          const db = open.result
          // The database is shared (see `review-queue-store.ts`): create every
          // store the app owns, so whichever module upgrades first leaves a
          // complete database behind.
          for (const name of ['reviewQueues', 'queryCache', 'importJobs'] as const) {
            if (!db.objectStoreNames.contains(name)) {
              db.createObjectStore(name)
            }
          }
        }
        open.onerror = () => reject(open.error ?? new Error('Could not open the import store.'))
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            // The database predates this store: widen the schema, then retry
            // the open so the upgrade that creates the store can run (see
            // `review-queue-store.ts` for the full pattern).
            const version = db.version + 1
            db.close()
            const retry = indexedDB.open(DB_NAME, version)
            retry.onupgradeneeded = () => {
              const upgraded = retry.result
              for (const name of ['reviewQueues', 'queryCache', 'importJobs'] as const) {
                if (!upgraded.objectStoreNames.contains(name)) {
                  upgraded.createObjectStore(name)
                }
              }
            }
            retry.onerror = () =>
              reject(retry.error ?? new Error('Could not open the import store.'))
            retry.onsuccess = () => {
              const retried = retry.result
              const transaction = retried.transaction(STORE_NAME, mode)
              transaction.oncomplete = () => retried.close()
              transaction.onabort = () => retried.close()
              const result = run(transaction.objectStore(STORE_NAME))
              result.onsuccess = () => resolve(result.result)
              result.onerror = () =>
                reject(result.error ?? new Error('The import store did not answer.'))
            }
            return
          }
          const transaction = db.transaction(STORE_NAME, mode)
          const result = run(transaction.objectStore(STORE_NAME))
          result.onsuccess = () => resolve(result.result)
          result.onerror = () =>
            reject(result.error ?? new Error('The import store did not answer.'))
          transaction.oncomplete = () => db.close()
        }
      }),
    catch: () => new ImportJobStoreUnavailable(),
  })

/**
 * The stored value as a job, or `None` when it is absent or not a job.
 *
 * IndexedDB is an external boundary, so the value it hands back is untrusted
 * and checked here rather than trusted.
 */
export const decodeImportJob = (value: unknown): Option.Option<StoredImportJob> => {
  if (typeof value !== 'object' || value === null) return Option.none()
  const record = value as Record<string, unknown>
  const { id, filename, blob } = record
  if (typeof id !== 'string' || typeof filename !== 'string') return Option.none()
  if (!(blob instanceof Blob)) return Option.none()
  return Option.some({
    id: ImportId.make(id),
    filename,
    byteLength: typeof record['byteLength'] === 'number' ? record['byteLength'] : blob.size,
    createdAt: typeof record['createdAt'] === 'number' ? record['createdAt'] : 0,
    blob,
  })
}

/** Keeps `job` as the one resumable Import. Overwrites any earlier record. */
export const saveImportJob = (
  job: StoredImportJob,
): Effect.Effect<void, ImportJobStoreUnavailable> =>
  request('readwrite', (store) => store.put(job, ACTIVE_KEY)).pipe(Effect.asVoid)

/** The resumable Import, or `None` when nothing is stored. */
export const loadImportJob = (): Effect.Effect<
  Option.Option<StoredImportJob>,
  ImportJobStoreUnavailable
> => request('readonly', (store) => store.get(ACTIVE_KEY)).pipe(Effect.map(decodeImportJob))

/** Drops the resumable Import. */
export const clearImportJob = (): Effect.Effect<void, ImportJobStoreUnavailable> =>
  request('readwrite', (store) => store.delete(ACTIVE_KEY)).pipe(Effect.asVoid)
