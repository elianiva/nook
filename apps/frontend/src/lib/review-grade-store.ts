/**
 * Durable outbox for optimistic review grades.
 *
 * A grade is written before its RPC starts and removed only after the server
 * accepts it. Replaying an entry uses its original id, so a response lost
 * after the server committed is safe to retry through the server's idempotent
 * review endpoint.
 */

import { Effect, Schema as S } from 'effect'
import { CardId, Grade } from '@nook/api'
import { runIdbRequest } from './idb'

const STORE_NAME = 'reviewGrades'

const StoredGrade = S.Struct({
  id: S.String,
  cardId: CardId,
  grade: Grade,
})

type QueuedGrade = { id: string; cardId: CardId; grade: Grade }

/** The browser refused to read or write its own storage. */
export class ReviewGradeStoreUnavailable extends Error {
  readonly _tag = 'ReviewGradeStoreUnavailable'
}

const request = <A>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<A>,
): Effect.Effect<A, ReviewGradeStoreUnavailable> =>
  Effect.tryPromise({
    try: () => runIdbRequest(STORE_NAME, mode, run),
    catch: () => new ReviewGradeStoreUnavailable(),
  })

/** Saves or refreshes the grade with its stable id. */
export const saveQueuedGrade = (
  grade: QueuedGrade,
): Effect.Effect<void, ReviewGradeStoreUnavailable> =>
  request('readwrite', (store) =>
    store.put({ id: grade.id, cardId: grade.cardId, grade: grade.grade }, grade.id),
  ).pipe(Effect.asVoid)

/** Removes a grade that the server has accepted. */
export const removeQueuedGrade = (id: string): Effect.Effect<void, ReviewGradeStoreUnavailable> =>
  request('readwrite', (store) => store.delete(id)).pipe(Effect.asVoid)

/** Loads the entire outbox; invalid records fail closed rather than vanish. */
export const loadQueuedGrades = (): Effect.Effect<
  ReadonlyArray<QueuedGrade>,
  ReviewGradeStoreUnavailable
> =>
  request('readonly', (store) => store.getAll()).pipe(
    Effect.flatMap((entries) => S.decodeUnknownEffect(S.Array(StoredGrade))(entries)),
    Effect.mapError(() => new ReviewGradeStoreUnavailable()),
  )
