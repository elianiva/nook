/**
 * Shared IndexedDB open logic for the `nook` database.
 *
 * The query cache, the review queue, and the import job all live in one
 * database with one store each. Whichever module upgrades first creates every
 * store, so a database created by an older version still gains the missing
 * stores on retry. One request runs per connection; the connection closes
 * when the request lands.
 */

export const NOOK_DB_NAME = 'nook'
export const NOOK_DB_VERSION = 5
export const NOOK_STORES = ['reviewQueues', 'queryCache', 'importJobs', 'reviewGrades'] as const

/** Runs one request against `storeName` and closes after its transaction settles. */
export const runIdbRequest = <A>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<A>,
): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('No IndexedDB in this environment.'))
      return
    }
    const open = indexedDB.open(NOOK_DB_NAME, NOOK_DB_VERSION)
    open.onupgradeneeded = () => {
      const db = open.result
      for (const name of NOOK_STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name)
        }
      }
    }
    open.onerror = () => reject(open.error ?? new Error(`Could not open ${storeName}.`))
    const runIn = (db: IDBDatabase, close: () => void): void => {
      let transaction: IDBTransaction
      try {
        transaction = db.transaction(storeName, mode)
      } catch (error) {
        close()
        reject(error instanceof Error ? error : new Error(`The ${storeName} did not answer.`))
        return
      }
      let settled = false
      let resultValue: { value: A } | undefined
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        close()
        reject(error)
      }
      transaction.oncomplete = () => {
        close()
        if (settled) return
        settled = true
        if (resultValue === undefined) {
          reject(new Error(`The ${storeName} transaction completed without a result.`))
          return
        }
        resolve(resultValue.value)
      }
      transaction.onerror = () =>
        fail(transaction.error ?? new Error(`The ${storeName} transaction failed.`))
      transaction.onabort = () =>
        fail(transaction.error ?? new Error(`The ${storeName} transaction was aborted.`))
      let result: IDBRequest<A>
      try {
        result = run(transaction.objectStore(storeName))
      } catch (error) {
        try {
          transaction.abort()
        } catch {
          // The transaction may already be inactive; the request still fails.
        }
        fail(error instanceof Error ? error : new Error(`The ${storeName} did not answer.`))
        return
      }
      result.onsuccess = () => {
        resultValue = { value: result.result }
      }
      result.onerror = () =>
        fail(result.error ?? new Error(`The ${storeName} request did not answer.`))
    }
    open.onsuccess = () => {
      const db = open.result
      if (!db.objectStoreNames.contains(storeName)) {
        // The database predates this store: widen the schema, then retry the
        // open so the upgrade that creates the store can run.
        const version = db.version + 1
        db.close()
        const retry = indexedDB.open(NOOK_DB_NAME, version)
        retry.onupgradeneeded = () => {
          const upgraded = retry.result
          for (const name of NOOK_STORES) {
            if (!upgraded.objectStoreNames.contains(name)) {
              upgraded.createObjectStore(name)
            }
          }
        }
        retry.onerror = () => reject(retry.error ?? new Error(`Could not open ${storeName}.`))
        retry.onsuccess = () => runIn(retry.result, () => retry.result.close())
        return
      }
      runIn(db, () => db.close())
    }
  })
