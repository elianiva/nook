/**
 * The review queue: due and new Cards within the day's limits.
 */

import { Effect, Option } from 'effect'
import { DeckId, StorageUnavailable } from '@nook/api'
import type { ReviewQueue } from '@nook/api'
import { dayStartUtc, resolveTimezone, reviewDayKey } from '../day-boundary'
import { CountRow, decodeRows, withStorageErrorPassThrough } from '../storage-error'
import type { ReviewsDeps } from './reads'
import { QUEUE_LIMIT, QueueRow, DeckLimitsRow, toReviewCard } from './rows'

export const makeQueue = ({ sql, readFsrs }: ReviewsDeps) => {
  /**
   * Due Cards first, then new ones, capped by the day's remaining limits.
   *
   * The review limit counts distinct Cards answered today (re-grades of
   * one Card count once, like Anki), and the new limit counts Cards
   * introduced today. A buried Card — a same-Note sibling of a graded
   * Card, or an `Again` waiting out its lapse — stays out until its
   * instant passes. `dueInDays` for a Card with no due instant (a new
   * Card) is 0.
   *
   * A deck page names one Deck, so that Deck's overrides win over
   * Settings; the all-decks queue keeps the global values. The answer
   * carries both the queue and the counts behind it, so the done screen
   * can name the limit instead of "nothing due".
   */
  const queue = (input: {
    deckId: Option.Option<DeckId>
    timezone?: string | undefined
    bypassDueLimit?: boolean | undefined
  }): Effect.Effect<ReviewQueue, StorageUnavailable> =>
    Effect.gen(function* () {
      const fsrs = yield* readFsrs
      const now = new Date()
      const timezone = resolveTimezone(input.timezone)
      const boundary = dayStartUtc(timezone, fsrs.dayRolloverHour, now)
      const todayKey = reviewDayKey(timezone, fsrs.dayRolloverHour, now)
      const deck = Option.getOrNull(input.deckId)

      const limitsRows =
        deck === null
          ? []
          : yield* sql`SELECT new_per_day AS "newPerDay", reviews_per_day AS "reviewsPerDay",
                lapse_minutes AS "lapseMinutes" FROM decks WHERE id = ${deck}`
      const limitsDecoded = yield* decodeRows(DeckLimitsRow, limitsRows)
      const override = limitsDecoded[0]
      const newPerDay = override?.newPerDay ?? fsrs.newPerDay
      const reviewsPerDay = override?.reviewsPerDay ?? fsrs.reviewsPerDay
      const lapseMinutes = override?.lapseMinutes ?? fsrs.lapseMinutes

      // Anki behaviour: one Card counts once, no matter how often it was
      // graded today. `Again` re-grades never consume the review limit.
      const reviewCountRows = yield* sql`SELECT COUNT(DISTINCT card_id) AS n FROM reviews
            WHERE reviewed_at >= ${boundary}
            AND (${deck} IS NULL OR card_id IN (SELECT id FROM cards WHERE deck_id = ${deck}))`
      const reviewCounts = yield* decodeRows(CountRow, reviewCountRows)
      const reviewedToday = reviewCounts[0]?.n ?? 0
      const newCountRows = yield* sql`SELECT COUNT(*) AS n FROM cards
            WHERE introduced_day >= ${todayKey} AND state != 'new'
            AND (${deck} IS NULL OR deck_id = ${deck})`
      const newCounts = yield* decodeRows(CountRow, newCountRows)
      const introducedToday = newCounts[0]?.n ?? 0

      // Totals before the limits, for the done screen's "N more tomorrow".
      const totalDueRows = yield* sql`SELECT COUNT(*) AS n FROM cards c
            WHERE c.suspended = 0 AND c.note_id IS NOT NULL
              AND (c.buried_until IS NULL OR c.buried_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
              AND c.state != 'new' AND c.due_at IS NOT NULL
              AND c.due_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              AND (${deck} IS NULL OR c.deck_id = ${deck})`
      const totalDue = (yield* decodeRows(CountRow, totalDueRows))[0]?.n ?? 0
      const totalNewRows = yield* sql`SELECT COUNT(*) AS n FROM cards c
            WHERE c.suspended = 0 AND c.note_id IS NOT NULL
              AND (c.buried_until IS NULL OR c.buried_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
              AND c.state = 'new'
              AND (${deck} IS NULL OR c.deck_id = ${deck})`
      const totalNew = (yield* decodeRows(CountRow, totalNewRows))[0]?.n ?? 0

      const dueAllowed = input.bypassDueLimit
        ? totalDue
        : Math.max(0, reviewsPerDay - reviewedToday)
      const newAllowed = input.bypassDueLimit ? 0 : Math.max(0, newPerDay - introducedToday)

      const rows = yield* sql`SELECT c.id AS "cardId", c.deck_id AS "deckId",
            c.note_id AS "noteId", n.import_id AS "importId", c.template_ord AS "templateOrd",
            c.state AS state, c.stability AS stability, c.difficulty AS difficulty,
            c.due_at AS "dueAt",
            COALESCE(CAST(julianday(c.due_at) - julianday('now') AS INTEGER), 0) AS "dueInDays",
            n.fields AS "noteFields", n.tags AS "noteTags",
            nt.name AS "noteTypeName", nt.kind AS "noteTypeKind", nt.css AS "noteTypeCss",
            nt.fields AS "noteTypeFields", nt.templates AS "noteTypeTemplates",
            d.name AS "deckName"
            FROM cards c
            JOIN notes n ON n.id = c.note_id
            JOIN note_types nt ON nt.id = n.note_type_id
            JOIN decks d ON d.id = c.deck_id
            WHERE c.suspended = 0 AND c.note_id IS NOT NULL
              AND (c.buried_until IS NULL OR c.buried_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
              AND (c.state = 'new' OR (c.due_at IS NOT NULL AND c.due_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
              AND (${input.bypassDueLimit ?? false} = 0 OR c.state != 'new')
              AND (${deck} IS NULL OR c.deck_id = ${deck})
            ORDER BY CASE WHEN c.state = 'new' THEN 1 ELSE 0 END, c.due_at
            LIMIT ${QUEUE_LIMIT}`
      const decoded = yield* decodeRows(QueueRow, rows)
      const dueWaiting = decoded.filter((row) => row.state !== 'new')
      const newWaiting = decoded.filter((row) => row.state === 'new')
      const due = dueWaiting.slice(0, dueAllowed)
      const fresh = newWaiting.slice(0, newAllowed)
      // A 200-Card prefetch can hold fewer due Cards than the limit
      // allows; only a limit cut counts as capped, never a short fetch.
      const dueCapped = dueWaiting.length > due.length || totalDue > due.length
      const newCapped =
        !input.bypassDueLimit && (newWaiting.length > fresh.length || totalNew > fresh.length)
      const cards = yield* Effect.forEach([...due, ...fresh], toReviewCard, { concurrency: 1 })
      return {
        cards,
        dayStartUtc: boundary,
        lapseMinutes,
        reviewedToday,
        newToday: introducedToday,
        totalNew,
        totalDue,
        newCapped,
        dueCapped,
      } satisfies ReviewQueue
    }).pipe(Effect.withSpan('Reviews.queue'), (self) =>
      withStorageErrorPassThrough(self, 'load the review queue'),
    )

  return queue
}
