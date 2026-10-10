/**
 * The review session transitions: grading, Again re-queue, Undo, and the
 * offline wait.
 *
 * These transitions are pure, so they are tested without a browser. The fetch
 * itself lives behind an Effect the test never runs.
 */

import { describe, expect, it } from '@effect/vitest'
import { Arbitrary, Option, Schema as S } from 'effect'
import { CardId, DeckId, ReviewCard } from '@nook/api'
import type { ReviewCard as ReviewCardData } from '@nook/api'
import { Message, seedModel } from '../src/app/model'
import type { Model } from '../src/app/model'
import { mediaUrlsIn } from '../src/app/api-commands'
import { init, update } from '../src/app/update'
import { names, url } from './helpers'

const card = (id: string, state: ReviewCardData['state'] = 'review'): ReviewCardData => ({
  cardId: CardId.make(id),
  deckId: DeckId.make('deck-a'),
  noteId: `note-${id}`,
  question: `q-${id}`,
  answer: `a-${id}`,
  css: '',
  state,
  dueAt: Option.none(),
  dueInDays: 0,
  stability: 2,
  difficulty: 5,
})

const reviewCard = Arbitrary.schema(ReviewCard).pipe(
  Arbitrary.filter(({ dueInDays, stability, difficulty }) =>
    [dueInDays, stability, difficulty].every(
      (value) => Number.isFinite(value) && !Object.is(value, -0),
    ),
  ),
)
const cardWithDueAt = Arbitrary.all({
  card: reviewCard,
  dueAt: Arbitrary.schema(S.String),
}).pipe(Arbitrary.map(({ card, dueAt }) => ({ ...card, dueAt: Option.some(dueAt) })))

const reviewing = (cards: ReadonlyArray<ReviewCardData>): Model => {
  const started = update(
    seedModel(url('/review')),
    Message.RestoredQueuedGrades({ grades: [] }),
  ).model
  const queued = update(
    started,
    Message.GotReviewQueue({
      sessionId: '',
      source: 'server',
      cards: [...cards],
      dayStartUtc: '2026-10-05T04:00:00Z',
      lapseMinutes: 10,
      reviewedToday: 0,
      newToday: 0,
      totalNew: cards.filter((card) => card.state === 'new').length,
      totalDue: cards.filter((card) => card.state !== 'new').length,
      newCapped: false,
      dueCapped: false,
      beyondLimit: false,
    }),
  ).model
  return update(queued, Message.RevealedAnswer()).model
}

describe('review session', () => {
  it('starts the cache load before the network queue', () => {
    expect(names(init(url('/review')))).toContain('LoadCachedQueue')
    expect(names(init(url('/review')))).toContain('FetchReviewQueue')
  })

  it('ignores queue responses from a previous review session', () => {
    const first = init(url('/review'))
    const oldSessionId = first.model.review.queueSessionId
    const leftReview = update(first.model, Message.ChangedUrl({ url: url('/') })).model
    const nextReview = update(leftReview, Message.ChangedUrl({ url: url('/review') })).model
    expect(nextReview.review.queueSessionId).not.toBe(oldSessionId)

    const lateResponse = update(
      nextReview,
      Message.GotReviewQueue({
        sessionId: oldSessionId,
        source: 'server',
        cards: [card('already-reviewed')],
        dayStartUtc: '2026-10-05T04:00:00Z',
        lapseMinutes: 10,
        reviewedToday: 1,
        newToday: 0,
        totalNew: 0,
        totalDue: 0,
        newCapped: false,
        dueCapped: false,
        beyondLimit: false,
      }),
    )
    expect(lateResponse.model.review.cards).toEqual([])
    expect(lateResponse.model.review.queueStatus).toBe('loading')
  })

  it('keeps the active session id while showing cache before the fresh queue', () => {
    const loaded = init(url('/review'))
    const sessionId = loaded.model.review.queueSessionId
    const cached = update(
      loaded.model,
      Message.GotReviewQueue({
        sessionId,
        source: 'cache',
        cards: [card('cached-card')],
        dayStartUtc: '2026-10-05T04:00:00Z',
        lapseMinutes: 10,
        reviewedToday: 0,
        newToday: 0,
        totalNew: 1,
        totalDue: 0,
        newCapped: false,
        dueCapped: false,
        beyondLimit: false,
      }),
    )
    expect(cached.model.review.queueSessionId).toBe(sessionId)

    const fresh = update(
      cached.model,
      Message.GotReviewQueue({
        sessionId,
        source: 'server',
        cards: [],
        dayStartUtc: '2026-10-05T04:00:00Z',
        lapseMinutes: 10,
        reviewedToday: 1,
        newToday: 0,
        totalNew: 0,
        totalDue: 0,
        newCapped: false,
        dueCapped: false,
        beyondLimit: false,
      }),
    )
    expect(fresh.model.review.queueSessionId).toBe(sessionId)
    expect(fresh.model.review.queueStatus).toBe('ready')
    expect(fresh.model.review.cards).toEqual([])
  })

  it('replaces a stale cached queue with an empty server queue and ignores late cache data', () => {
    const started = update(
      seedModel(url('/review')),
      Message.RestoredQueuedGrades({ grades: [] }),
    ).model
    const cached = update(
      started,
      Message.GotReviewQueue({
        sessionId: '',
        source: 'cache',
        cards: [card('already-reviewed')],
        dayStartUtc: '2026-10-05T04:00:00Z',
        lapseMinutes: 10,
        reviewedToday: 0,
        newToday: 0,
        totalNew: 1,
        totalDue: 0,
        newCapped: false,
        dueCapped: false,
        beyondLimit: false,
      }),
    ).model
    expect(cached.review.phase).toBe('reviewing')
    expect(cached.review.queueStatus).toBe('loading')
    const earlyReveal = update(cached, Message.RevealedAnswer()).model
    expect(earlyReveal.review.revealed).toBe(false)

    const checked = update(
      cached,
      Message.GotReviewQueue({
        sessionId: '',
        source: 'server',
        cards: [],
        dayStartUtc: '2026-10-05T04:00:00Z',
        lapseMinutes: 10,
        reviewedToday: 1,
        newToday: 0,
        totalNew: 0,
        totalDue: 0,
        newCapped: false,
        dueCapped: false,
        beyondLimit: false,
      }),
    )
    expect(checked.model.review.phase).toBe('done')
    expect(checked.model.review.cards).toEqual([])
    expect(checked.model.review.queueStatus).toBe('ready')
    expect(names(checked)).toEqual(['PersistReviewQueue'])
    expect(checked.commands?.[0]).toMatchObject({ args: { cards: [] } })

    const lateCache = update(
      checked.model,
      Message.GotReviewQueue({
        sessionId: '',
        source: 'cache',
        cards: [card('already-reviewed')],
        dayStartUtc: '2026-10-05T04:00:00Z',
        lapseMinutes: 10,
        reviewedToday: 0,
        newToday: 0,
        totalNew: 1,
        totalDue: 0,
        newCapped: false,
        dueCapped: false,
        beyondLimit: false,
      }),
    ).model
    expect(lateCache.review.cards).toEqual([])
  })

  it('allows a cached queue only after the fresh check fails offline', () => {
    const started = update(
      seedModel(url('/review')),
      Message.RestoredQueuedGrades({ grades: [] }),
    ).model
    const cached = update(
      started,
      Message.GotReviewQueue({
        sessionId: '',
        source: 'cache',
        cards: [card('c1')],
        dayStartUtc: '2026-10-05T04:00:00Z',
        lapseMinutes: 10,
        reviewedToday: 0,
        newToday: 0,
        totalNew: 0,
        totalDue: 1,
        newCapped: false,
        dueCapped: false,
        beyondLimit: false,
      }),
    ).model
    const offline = update(
      cached,
      Message.LoadFailed({ error: 'offline', retry: 'reviewQueue' }),
    ).model
    const revealed = update(offline, Message.RevealedAnswer()).model
    expect(revealed.review.revealed).toBe(true)
    expect(names(update(revealed, Message.ClickedGrade({ grade: 'Good' })))).toEqual([
      'SaveQueuedGrade',
      'PersistReviewQueue',
    ])
  })

  it('removes a fetched Card if its earlier offline grade restores afterward', () => {
    const queued = {
      id: 'offline-grade',
      cardId: CardId.make('c1'),
      grade: 'Good' as const,
      seq: 0,
      persisted: true,
    }
    const fetched = update(
      seedModel(url('/review')),
      Message.GotReviewQueue({
        sessionId: '',
        source: 'server',
        cards: [card('c1'), card('c2')],
        dayStartUtc: '2026-10-05T04:00:00Z',
        lapseMinutes: 10,
        reviewedToday: 0,
        newToday: 0,
        totalNew: 0,
        totalDue: 2,
        newCapped: false,
        dueCapped: false,
        beyondLimit: false,
      }),
    ).model
    expect(fetched.queuedGradesRestored).toBe(false)
    expect(update(fetched, Message.RevealedAnswer()).model.review.revealed).toBe(false)

    const restored = update(fetched, Message.RestoredQueuedGrades({ grades: [queued] }))
    expect(restored.model.queuedGradesRestored).toBe(true)
    expect(restored.model.review.cards.map((entry) => entry.cardId)).toEqual(['c2'])
    expect(names(restored)).toEqual(['SubmitGrade', 'PersistReviewQueue'])
  })

  it('re-queues an Again Card at the end of the queue', () => {
    const model = reviewing([card('c1'), card('c2')])
    const graded = update(model, Message.ClickedGrade({ grade: 'Again' }))
    expect(graded.model.review.cards.length).toBe(3)
    expect(graded.model.review.cards[2]?.cardId).toBe('c1')
    expect(graded.model.review.requeue.length).toBe(1)
    expect(graded.model.review.phase).toBe('reviewing')
    expect(names(graded)).toEqual(['SaveQueuedGrade', 'PersistReviewQueue'])
    const savedQueue = graded.commands?.find((command) => command.name === 'PersistReviewQueue')
    expect(savedQueue).toMatchObject({ args: { cards: [{ cardId: 'c2' }, { cardId: 'c1' }] } })
  })

  it('does not re-queue a passing grade', () => {
    const model = reviewing([card('c1'), card('c2')])
    const graded = update(model, Message.ClickedGrade({ grade: 'Good' }))
    expect(graded.model.review.cards.length).toBe(2)
    expect(graded.model.review.requeue.length).toBe(0)
    expect(graded.model.review.index).toBe(1)
  })

  it('suspends the current Card without grading it or losing its review history', () => {
    const model = reviewing([card('c1'), card('c2')])
    const requested = update(model, Message.ClickedSuspendCurrentCard())
    expect(names(requested)).toEqual(['SetCardSuspended'])
    expect(requested.model.review.graded).toBe(0)
    expect(requested.model.review.suspensionPending).toEqual(Option.some(CardId.make('c1')))

    const saved = update(
      requested.model,
      Message.CardSuspensionSaved({
        cardId: CardId.make('c1'),
        suspended: true,
        origin: 'review',
      }),
    )
    expect(saved.model.review.cards.map((entry) => entry.cardId)).toEqual(['c2'])
    expect(saved.model.review.index).toBe(0)
    expect(saved.model.review.graded).toBe(0)
    expect(saved.model.review.phase).toBe('reviewing')
    expect(Option.isNone(saved.model.review.suspensionPending)).toBe(true)
  })

  it('removes a newly suspended leech from the in-session Again requeue', () => {
    const graded = update(
      reviewing([card('c1'), card('c2')]),
      Message.ClickedGrade({ grade: 'Again' }),
    )
    const entry = graded.model.review.pending[0]
    expect(entry).toBeDefined()
    if (entry === undefined) return

    const saved = update(graded.model, Message.QueuedGradeSaved({ id: entry.id }))
    expect(names(saved)).toEqual(['SubmitGrade'])

    const accepted = update(
      saved.model,
      Message.GradeAccepted({
        id: entry.id,
        accepted: {
          cardId: entry.cardId,
          grade: 'Again',
          state: 'relearning',
          dueInDays: 0,
          stability: 1,
          difficulty: 5,
          reviewLapses: 8,
          intervalDays: 0,
          dueAt: '2026-10-05T04:10:00Z',
          requeueInSession: true,
          leechSuspended: true,
        },
      }),
    )
    expect(accepted.model.review.cards.map((card) => card.cardId)).toEqual(['c2'])
    expect(accepted.model.review.requeue).toEqual([])
    expect(accepted.model.review.index).toBe(0)
    expect(accepted.model.review.leechSuspendedCard).toEqual(Option.some(card('c1')))
    expect(accepted.model.review.leechSuspendedReviewLapses).toBe(8)

    const undone = update(accepted.model, Message.UndoneGrade({ cardId: CardId.make('c1') }))
    expect(undone.model.review.cards.map((entry) => entry.cardId)).toEqual(['c1', 'c2'])
    expect(undone.model.review.index).toBe(0)
    expect(Option.isNone(undone.model.review.leechSuspendedCard)).toBe(true)
  })

  it('ends the session after the re-queued Card is graded', () => {
    let model = reviewing([card('c1')])
    model = update(model, Message.ClickedGrade({ grade: 'Again' })).model
    expect(model.review.phase).toBe('reviewing')
    model = update(model, Message.RevealedAnswer()).model
    const done = update(model, Message.ClickedGrade({ grade: 'Good' }))
    expect(done.model.review.phase).toBe('done')
    expect(done.model.review.graded).toBe(2)
  })

  it('undoes the last grade and steps back to its Card', () => {
    let model = reviewing([card('c1'), card('c2')])
    const first = model.review.cards[model.review.index]
    model = update(model, Message.ClickedGrade({ grade: 'Good' })).model
    expect(model.review.graded).toBe(1)
    expect(names(update(model, Message.ClickedUndoGrade()))).toEqual([])
    const id = model.queuedGrades[0]?.id
    expect(id).toBeDefined()
    if (id === undefined) return
    model = update(model, Message.QueuedGradeSaved({ id })).model
    const accepted = update(
      model,
      Message.GradeAccepted({
        id,
        accepted: {
          cardId: CardId.make('c1'),
          grade: 'Good',
          state: 'review',
          dueInDays: 1,
          stability: 2,
          difficulty: 5,
          reviewLapses: 0,
          intervalDays: 1,
          dueAt: '2026-10-06T04:00:00Z',
          requeueInSession: false,
          leechSuspended: false,
        },
      }),
    )
    model = accepted.model
    expect(names(update(model, Message.ClickedUndoGrade()))).toEqual(['UndoGrade'])

    const undone = update(
      model,
      Message.UndoneGrade({ cardId: first?.cardId ?? CardId.make('missing') }),
    )
    expect(undone.model.review.graded).toBe(0)
    expect(undone.model.review.index).toBe(0)
    expect(undone.model.review.undone).toBe(true)
    expect(undone.model.review.phase).toBe('reviewing')
  })

  it('queues a failed grade offline and flushes it on retry', () => {
    const model = reviewing([card('c1')])
    const graded = update(model, Message.ClickedGrade({ grade: 'Good' }))
    const id = graded.model.review.pending[0]?.id
    expect(id).toBeDefined()
    if (id === undefined) return
    const saved = update(graded.model, Message.QueuedGradeSaved({ id }))
    expect(names(saved)).toEqual(['SubmitGrade'])
    const failed = update(saved.model, Message.GradeFailed({ id, error: 'offline', durable: true }))
    expect(failed.model.review.offline.length).toBe(1)
    expect(failed.model.review.graded).toBe(1)
    expect(failed.model.queuedGrades).toHaveLength(1)

    const retried = update(failed.model, Message.ClickedRetryGrades())
    expect(names(retried)).toEqual(['SubmitGrade'])
  })

  it('does not call a grade durable when this device could not persist it', () => {
    const graded = update(reviewing([card('c1')]), Message.ClickedGrade({ grade: 'Good' }))
    const id = graded.model.review.pending[0]?.id
    expect(id).toBeDefined()
    if (id === undefined) return

    const failed = update(
      graded.model,
      Message.GradeFailed({
        id,
        error: 'storage unavailable',
        durable: false,
      }),
    )
    expect(failed.model.review.pending).toEqual([])
    expect(failed.model.review.offline).toEqual([])
    expect(failed.model.queuedGrades.map((entry) => entry.id)).toEqual([id])

    const retried = update(failed.model, Message.ClickedRetryGrades())
    expect(names(retried)).toEqual(['SaveQueuedGrade'])
    expect(names(update(retried.model, Message.QueuedGradeSaved({ id })))).toEqual(['SubmitGrade'])
  })

  it('drains grades in durable order and never lets a later grade pass a failed head', () => {
    const first = update(
      reviewing([card('c1'), card('c2')]),
      Message.ClickedGrade({ grade: 'Again' }),
    )
    const firstEntry = first.model.queuedGrades[0]
    expect(firstEntry?.seq).toBe(0)
    if (firstEntry === undefined) return

    const firstSaved = update(first.model, Message.QueuedGradeSaved({ id: firstEntry.id }))
    expect(names(firstSaved)).toEqual(['SubmitGrade'])
    expect(firstSaved.model.gradeInFlight).toEqual(Option.some(firstEntry.id))

    const secondRevealed = update(firstSaved.model, Message.RevealedAnswer()).model
    const second = update(secondRevealed, Message.ClickedGrade({ grade: 'Good' }))
    const secondEntry = second.model.queuedGrades[1]
    expect(secondEntry?.seq).toBe(1)
    if (secondEntry === undefined) return

    const secondSaved = update(second.model, Message.QueuedGradeSaved({ id: secondEntry.id }))
    expect(names(secondSaved)).toEqual([])
    expect(secondSaved.model.queuedGrades.map((entry) => entry.id)).toEqual([
      firstEntry.id,
      secondEntry.id,
    ])

    const failed = update(
      secondSaved.model,
      Message.GradeFailed({ id: firstEntry.id, error: 'offline', durable: true }),
    )
    expect(failed.model.gradeBlocked).toBe(true)
    const retried = update(failed.model, Message.ClickedRetryGrades())
    expect(names(retried)).toEqual(['SubmitGrade'])

    const firstAccepted = update(
      retried.model,
      Message.GradeAccepted({
        id: firstEntry.id,
        accepted: {
          cardId: firstEntry.cardId,
          grade: firstEntry.grade,
          state: 'relearning',
          dueInDays: 0,
          stability: 1,
          difficulty: 5,
          reviewLapses: 1,
          intervalDays: 0,
          dueAt: '2026-10-05T04:10:00Z',
          requeueInSession: true,
          leechSuspended: false,
        },
      }),
    )
    expect(firstAccepted.model.queuedGrades.map((entry) => entry.id)).toEqual([secondEntry.id])
    expect(names(firstAccepted)).toEqual(['SubmitGrade'])
    expect(firstAccepted.commands?.[0]).toMatchObject({
      args: { id: secondEntry.id, cardId: secondEntry.cardId, grade: 'Good' },
    })
  })

  it('restores an outbox in sequence order rather than IndexedDB key order', () => {
    const restored = update(
      seedModel(url('/review')),
      Message.RestoredQueuedGrades({
        grades: [
          {
            id: 'grade-z',
            cardId: CardId.make('c3'),
            grade: 'Easy',
            seq: 2,
            persisted: true,
          },
          {
            id: 'grade-a',
            cardId: CardId.make('c1'),
            grade: 'Again',
            seq: 0,
            persisted: true,
          },
          {
            id: 'grade-m',
            cardId: CardId.make('c2'),
            grade: 'Good',
            seq: 1,
            persisted: true,
          },
        ],
      }),
    )

    expect(restored.model.queuedGrades.map((entry) => entry.id)).toEqual([
      'grade-a',
      'grade-m',
      'grade-z',
    ])
    expect(names(restored)).toEqual(['SubmitGrade'])
    expect(restored.commands?.[0]).toMatchObject({ args: { id: 'grade-a', grade: 'Again' } })
  })

  it('restores and retries grades from the durable outbox at boot', () => {
    const queued = {
      id: 'grade-1',
      cardId: CardId.make('c1'),
      grade: 'Good' as const,
      seq: 0,
      persisted: true,
    }
    const restored = update(
      seedModel(url('/review')),
      Message.RestoredQueuedGrades({ grades: [queued] }),
    )
    expect(restored.model.queuedGrades).toEqual([queued])
    expect(restored.model.review.pending).toEqual([queued])
    expect(restored.model.review.offline).toEqual([])
    expect(names(restored)).toEqual(['SubmitGrade'])

    const accepted = update(
      restored.model,
      Message.GradeAccepted({
        id: queued.id,
        accepted: {
          cardId: queued.cardId,
          grade: queued.grade,
          state: 'review',
          dueInDays: 1,
          stability: 2,
          difficulty: 5,
          reviewLapses: 0,
          intervalDays: 1,
          dueAt: '2026-10-06T04:00:00Z',
          requeueInSession: false,
          leechSuspended: false,
        },
      }),
    )
    expect(accepted.model.queuedGrades).toEqual([])
    expect(accepted.model.review.offline).toEqual([])
  })

  it('continues with due cards only when the learner bypasses the daily cap', () => {
    const due = card('c1')
    const started = update(
      seedModel(url('/review')),
      Message.RestoredQueuedGrades({ grades: [] }),
    ).model
    const model = update(
      started,
      Message.GotReviewQueue({
        sessionId: '',
        source: 'server',
        cards: [due],
        dayStartUtc: '2026-10-05T04:00:00Z',
        lapseMinutes: 10,
        reviewedToday: 1,
        newToday: 0,
        totalNew: 0,
        totalDue: 3,
        newCapped: false,
        dueCapped: true,
        beyondLimit: false,
      }),
    ).model
    const revealed = update(model, Message.RevealedAnswer()).model
    const exhausted = update(revealed, Message.ClickedGrade({ grade: 'Good' })).model
    expect(exhausted.review.phase).toBe('done')

    const continued = update(exhausted, Message.ClickedContinuePastDueLimit())
    expect(continued.model.review.bypassDueLimit).toBe(true)
    expect(names(continued)).toEqual(['FetchReviewQueue'])

    const added = update(
      continued.model,
      Message.GotReviewQueue({
        sessionId: continued.model.review.queueSessionId,
        source: 'server',
        // The bypass response can overlap the current session's queue.
        cards: [card('c1'), card('c2')],
        dayStartUtc: '2026-10-05T04:00:00Z',
        lapseMinutes: 10,
        reviewedToday: 1,
        newToday: 0,
        totalNew: 0,
        totalDue: 2,
        newCapped: false,
        dueCapped: false,
        beyondLimit: true,
      }),
    )
    expect(added.model.review.cards.map((entry) => entry.cardId)).toEqual(['c1', 'c2'])
    expect(added.model.review.index).toBe(1)
    expect(added.model.review.graded).toBe(1)
    expect(added.model.review.bypassDueLimit).toBe(true)
  })

  it('sends the learner timezone with the queue fetch', () => {
    const loaded = init(url('/review'))
    const fetch = (loaded.commands ?? []).find((command) => command.name === 'FetchReviewQueue')
    expect(fetch).toBeDefined()
  })

  it('finds the queued cards media for the offline cache warm', () => {
    const withMedia: ReviewCardData = {
      ...card('c1'),
      question: '<img src="/api/media/cat.jpg">',
      answer: 'FrontSide<hr><audio src="/api/media/hello%20world.mp3" controls>',
    }
    const plain = card('c2')
    expect(mediaUrlsIn([withMedia, plain])).toEqual([
      '/api/media/cat.jpg',
      '/api/media/hello world.mp3',
    ])
    expect(mediaUrlsIn([plain])).toEqual([])
    // One entry per URL no matter how many cards name it.
    expect(mediaUrlsIn([withMedia, withMedia])).toEqual([
      '/api/media/cat.jpg',
      '/api/media/hello world.mp3',
    ])
  })

  it.prop(
    'keeps any queue, including a due date, through a clone-shaped trip',
    [cardWithDueAt, Arbitrary.array(reviewCard)],
    ([withDue, rest]) => {
      // `ReviewCard.dueAt` is an `Option`, whose tag fields do not survive the
      // structured clone — the same fault that emptied every cached deck. The
      // queue persist encodes to plain JSON first, so a clone in between must
      // not lose the card.
      const json = S.toCodecJson(S.Array(ReviewCard))
      const queue = [withDue, ...rest]
      const stored = S.encodeUnknownOption(json)(queue)
      expect(Option.isSome(stored)).toBe(true)
      if (Option.isSome(stored)) {
        const cloned = JSON.parse(JSON.stringify(stored.value)) as unknown
        const decoded = S.decodeUnknownOption(json)(cloned)
        expect(Option.isSome(decoded)).toBe(true)
        if (Option.isSome(decoded)) {
          expect(decoded.value).toEqual(queue)
        }
      }
    },
  )
})
