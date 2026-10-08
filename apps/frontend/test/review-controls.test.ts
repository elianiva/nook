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
  const started = seedModel(url('/review'))
  const queued = update(
    started,
    Message.GotReviewQueue({
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
