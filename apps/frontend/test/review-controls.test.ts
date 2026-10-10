import { Option } from 'effect'
import { CardId, DeckId, type ReviewCard } from '@nook/api'
import { attr, findAll, getByRole, given, scene, tap } from 'foldkit/scene'
import { expect, it } from 'vitest'
import type { HtmlBuilder } from 'foldkit/html'
import { Message, seedModel } from '../src/app/model'
import { reviewView } from '../src/app/review'
import { update } from '../src/app/update'
import type { Model } from '../src/app/model'
import { url } from './helpers'

const card = (id: string): ReviewCard => ({
  cardId: CardId.make(id),
  deckId: DeckId.make('deck-review-controls'),
  noteId: `note-${id}`,
  question: `q-${id}`,
  answer: `a-${id}`,
  css: '',
  state: 'review',
  dueAt: Option.none(),
  dueInDays: 0,
  stability: 2,
  difficulty: 5,
})

const reviewing = (): Model => {
  const started = update(
    seedModel(url('/review')),
    Message.RestoredQueuedGrades({ grades: [] }),
  ).model
  const queued = update(
    started,
    Message.GotReviewQueue({
      sessionId: '',
      source: 'server',
      cards: [card('card-a'), card('card-b')],
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
  return update(queued, Message.RevealedAnswer()).model
}

const checkingCachedQueue = (): Model =>
  update(
    update(seedModel(url('/review')), Message.RestoredQueuedGrades({ grades: [] })).model,
    Message.GotReviewQueue({
      sessionId: '',
      source: 'cache',
      cards: [card('cached-card')],
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

const view = (model: Model, h: HtmlBuilder<Message>) => h.div([], reviewView(model, h))

it('renders quiet grade accents with neutral Undo and Suspend actions', () => {
  scene(
    { update, view },
    given(reviewing()),
    tap(({ html }) => {
      const gradeAccents = findAll(html, '.grade-accent')
      expect(gradeAccents).toHaveLength(4)
      expect(
        gradeAccents.map((accent) => Option.getOrElse(attr(accent, 'class'), () => '')),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining('bg-destructive'),
          expect.stringContaining('bg-orange-500'),
          expect.stringContaining('bg-primary'),
          expect.stringContaining('bg-emerald-500'),
        ]),
      )

      const suspend = getByRole('button', { name: 'Suspend card' })(html)
      expect(Option.isSome(suspend)).toBe(true)
      if (Option.isNone(suspend)) throw new Error('Suspend card button is missing')
      const suspendClasses = Option.getOrElse(attr(suspend.value, 'class'), () => '')
      expect(suspendClasses).toContain('bg-[var(--theme-block)]')
      expect(suspendClasses).toContain('border-0')

      const undo = getByRole('button', { name: 'Undo grade' })(html)
      expect(Option.isSome(undo)).toBe(true)
      if (Option.isNone(undo)) throw new Error('Undo grade button is missing')
      const undoClasses = Option.getOrElse(attr(undo.value, 'class'), () => '')
      expect(undoClasses).toContain('bg-[var(--theme-block)]')
      expect(undoClasses).toContain('border-0')
    }),
  )
})

it('keeps cached review actions disabled until the fresh queue check settles', () => {
  scene(
    { update, view },
    given(checkingCachedQueue()),
    tap(({ html }) => {
      const showAnswer = getByRole('button', { name: 'Show answer' })(html)
      expect(Option.isSome(showAnswer)).toBe(true)
      if (Option.isNone(showAnswer)) throw new Error('Show answer button is missing')
      expect(attr(showAnswer.value, 'aria-disabled')).toEqual(Option.some('true'))
    }),
  )
})

it('keeps Undo disabled until the queued grade is confirmed', () => {
  const graded = update(reviewing(), Message.ClickedGrade({ grade: 'Good' })).model
  expect(Option.isSome(graded.review.lastGrade)).toBe(true)

  scene(
    { update, view },
    given(graded),
    tap(({ html }) => {
      const undo = getByRole('button', { name: 'Undo grade' })(html)
      expect(Option.isSome(undo)).toBe(true)
      if (Option.isNone(undo)) throw new Error('Undo grade button is missing')
      expect(attr(undo.value, 'aria-disabled')).toEqual(Option.some('true'))
    }),
  )
})
