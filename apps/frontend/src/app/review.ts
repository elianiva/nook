/**
 * Review screen: one Card at a time, graded with FSRS.
 *
 * The Worker renders both sides and the Note Type's stylesheet, so this screen
 * only shows what it was given. The Card lives in `#nook-card`, which is the
 * element the server scoped the Note Type's CSS to, so a deck's own styling
 * cannot leak into the app around it.
 *
 * The layout is built for one hand: the Card fills the screen, and the actions
 * sit in a bar under the thumb. Reveal, then grade. Grading advances the Card
 * immediately and sends the Grade in the background, so the screen never waits
 * for the network. `Again` returns the Card later this session; Undo steps
 * back one grade.
 */

import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { Check, Download, Inbox, Undo2 } from 'lucide'
import { button } from '@/components/ui/button'
import { Empty } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { Grade, ReviewCard } from '@nook/api'
import { Message } from './model'
import type { Model } from './model'
import { routeToUrl } from './routes'

type Child = Html | string

/** The four Grades, in FSRS's order, each with its own solid colour. */
const GRADES: ReadonlyArray<{ grade: Grade; className: string }> = [
  {
    grade: 'Again',
    className:
      'border-0 bg-destructive text-destructive-foreground shadow-none hover:bg-destructive/90',
  },
  {
    grade: 'Hard',
    className: 'border-0 bg-orange-500 text-white shadow-none hover:bg-orange-500/90',
  },
  {
    grade: 'Good',
    className: 'border-0 bg-primary text-primary-foreground shadow-none hover:bg-primary/90',
  },
  {
    grade: 'Easy',
    className: 'border-0 bg-emerald-500 text-white shadow-none hover:bg-emerald-500/90',
  },
]

const centered = (children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        'flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center',
      ),
    ],
    children,
  )

const loadingView = (h: HtmlBuilder<Message>): ReadonlyArray<Child> => [
  h.div(
    [h.Class('flex min-h-0 flex-1 flex-col gap-2 px-4 pt-3'), h.Role('status')],
    [
      h.span([h.Class('sr-only')], ['Loading Cards…']),
      h.div([h.Class('h-1 w-full animate-pulse rounded-full bg-[var(--theme-block)]')], []),
      h.div(
        [h.Class('m-auto w-full animate-pulse rounded-2xl bg-[var(--theme-block)] px-5 py-8')],
        [
          h.div([h.Class('mx-auto h-5 w-2/3 rounded-[10px] bg-white/80')], []),
          h.div([h.Class('mx-auto mt-3 h-5 w-1/2 rounded-[10px] bg-white/80')], []),
        ],
      ),
    ],
  ),
]

const doneView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Child> => {
  const review = model.review
  const graded = review.graded
  const saving = review.pending.length
  const queued = review.offline.length
  const nothingDue = graded === 0 && review.cards.length === 0
  // The queue caps by the limits: a capped queue stops although Cards stay.
  // Name the remainder from the queue's totals minus what it served, so
  // "Session complete" never reads as "deck finished".
  const capped = review.doneKind === 'limits' || review.queueDueCapped || review.queueNewCapped
  const remaining = Math.max(
    0,
    review.queueTotalDue - review.queueServedDue + (review.queueTotalNew - review.queueServedNew),
  )
  return [
    centered(
      [
        Empty<Message>(
          {},
          [
            Empty.media<Message>(
              { variant: 'icon' },
              [icon(h, nothingDue && !capped ? Inbox : Check, 'size-4')],
              h,
            ),
            Empty.title<Message>(
              {},
              [
                nothingDue && !capped
                  ? 'Nothing due'
                  : capped
                    ? 'Daily limit reached'
                    : 'Session complete',
              ],
              h,
            ),
            Empty.description<Message>(
              {},
              [
                nothingDue && !capped
                  ? 'Every Card in this queue is scheduled for later.'
                  : capped
                    ? `You reviewed ${graded} ${graded === 1 ? 'Card' : 'Cards'}. ${remaining} more ${remaining === 1 ? 'waits' : 'wait'} past today's limits.`
                    : `You reviewed ${graded} ${graded === 1 ? 'Card' : 'Cards'}. They come back when FSRS says so.`,
              ],
              h,
            ),
            ...(saving === 0
              ? []
              : [h.p([h.Class('text-[11px] text-muted-foreground')], [`Saving ${saving}…`])]),
            ...(queued === 0
              ? []
              : [
                  h.p(
                    [h.Class('text-[11px] text-amber-600')],
                    [
                      `${queued} ${queued === 1 ? 'grade' : 'grades'} saved on this device — they send when the network returns.`,
                    ],
                  ),
                ]),
            Empty.content<Message>(
              {},
              [
                h.div(
                  [h.Class('flex flex-col items-center justify-center gap-2')],
                  [
                    ...(review.queueDueCapped && review.queueTotalDue > 0
                      ? [
                          button<Message>(
                            {
                              onClick: Message.ClickedContinuePastDueLimit(),
                              size: 'sm',
                              className: 'w-full',
                            },
                            ['Review due Cards anyway · this session only'],
                            h,
                          ),
                        ]
                      : []),
                    h.div(
                      [h.Class('flex items-center justify-center gap-2')],
                      [
                        h.a(
                          [
                            h.Href(routeToUrl({ _tag: 'Decks' })),
                            h.Class('text-xs font-medium text-primary hover:underline'),
                          ],
                          ['Back to decks'],
                        ),
                        button<Message>(
                          {
                            onClick: Message.ClickedExport(),
                            size: 'sm',
                          },
                          [icon(h, Download, 'size-3.5', 'inline-start'), 'Export collection'],
                          h,
                        ),
                      ],
                    ),
                  ],
                ),
              ],
              h,
            ),
          ],
          h,
        ),
      ],
      h,
    ),
  ]
}

const cardBody = (card: ReviewCard, revealed: boolean, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id('nook-card'), h.Class('w-full')],
    [
      h.div(
        [
          h.Class('card rounded-2xl border-0 bg-[var(--theme-block)] px-5 py-8 shadow-none'),
          h.InnerHTML(revealed ? card.answer : card.question),
        ],
        [],
      ),
    ],
  )

/** The four Grades, sized for a thumb: one row, full width, 56px tall. */
const gradeRow = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex gap-2')],
    GRADES.map(({ grade, className }) =>
      button<Message>(
        {
          onClick: Message.ClickedGrade({ grade }),
          size: '2xl',
          className: cn(
            'flex-1 flex-col gap-0 select-none transition-transform active:scale-[0.97]',
            className,
          ),
        },
        [grade],
        h,
      ),
    ),
  )

const errorBanner = (error: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        'mb-2 flex items-center gap-2 rounded-[14px] border-0 bg-[var(--theme-block)] px-3 py-2',
      ),
      h.Role('alert'),
    ],
    [
      h.span([h.Class('min-w-0 flex-1 text-xs text-destructive')], [error]),
      button<Message>({ onClick: Message.ClickedRetryGrades(), size: 'sm' }, ['Retry'], h),
    ],
  )

export const reviewView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Child> => {
  const review = model.review
  if (review.phase === 'loading') return loadingView(h)
  if (review.phase === 'done') return doneView(model, h)

  const card = review.cards[review.index]
  if (card === undefined) return doneView(model, h)

  const total = review.cards.length
  const answered = review.index + (review.revealed ? 1 : 0)
  const percent = total === 0 ? 0 : Math.round((answered / total) * 100)
  const saving = review.pending.length
  const canUndo = Option.isSome(review.lastGrade)
  const requeued = review.requeue.length
  const tapToReveal = model.settings.behaviour.tapToReveal

  const error = Option.match(review.error, {
    onNone: () => null,
    onSome: (message) => message,
  })

  return [
    h.style([], [card.css]),
    h.div(
      [h.Class('flex min-h-0 flex-1 flex-col')],
      [
        // Where the session is, out of the way of the thumb.
        h.div(
          [h.Class('flex shrink-0 flex-col gap-2 px-4 pt-3')],
          [
            Progress<Message>({ value: percent }, h),
            h.div(
              [
                h.Class(
                  'flex items-center justify-between text-[11px] font-medium text-muted-foreground',
                ),
              ],
              [
                h.span([], [`Card ${review.index + 1} of ${total}`]),
                h.span(
                  review.offline.length > 0
                    ? [h.Class('flex items-center gap-1 text-amber-600')]
                    : saving > 0
                      ? [h.Class('text-primary')]
                      : [],
                  [
                    review.offline.length > 0
                      ? `${review.offline.length} offline`
                      : saving > 0
                        ? `Saving ${saving}…`
                        : `${review.graded} reviewed`,
                  ],
                ),
              ],
            ),
          ],
        ),
        // The Card, centred, and the only part that scrolls. `m-auto` centres
        // it while it fits and collapses to 0 when it does not, so a tall Card
        // stays reachable instead of overflowing above the scroll start.
        h.div(
          [
            h.Class('flex min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4'),
            ...(tapToReveal && !review.revealed ? [h.OnClick(Message.RevealedAnswer())] : []),
          ],
          [h.div([h.Class('m-auto w-full')], [cardBody(card, review.revealed, h)])],
        ),
        // The action bar, under the thumb.
        h.div(
          [h.Class('shrink-0 border-0 bg-background/95 px-4 pt-3 pb-safe backdrop-blur')],
          [
            ...(error === null ? [] : [errorBanner(error, h)]),
            ...(review.undone
              ? [
                  h.p(
                    [h.Class('pb-2 text-center text-[11px] text-emerald-600')],
                    ['Undone — the Card is back as it was.'],
                  ),
                ]
              : []),
            ...(requeued === 0
              ? []
              : [
                  h.p(
                    [h.Class('pb-2 text-center text-[11px] text-muted-foreground')],
                    [
                      `${requeued} lapsed ${requeued === 1 ? 'Card returns' : 'Cards return'} later this session.`,
                    ],
                  ),
                ]),
            h.div(
              [h.Class('flex gap-2')],
              [
                h.div(
                  [h.Class('flex-1')],
                  [
                    review.revealed
                      ? gradeRow(h)
                      : button<Message>(
                          {
                            onClick: Message.RevealedAnswer(),
                            size: 'xl',
                            className:
                              'w-full select-none transition-transform active:scale-[0.99]',
                          },
                          ['Show answer'],
                          h,
                        ),
                  ],
                ),
                button<Message>(
                  {
                    onClick: Message.ClickedUndoGrade(),
                    size: 'xl',
                    className: 'shrink-0 select-none px-3',
                    isDisabled: !canUndo,
                  },
                  [icon(h, Undo2, 'size-4')],
                  h,
                ),
              ],
            ),
            h.p(
              [h.Class('hidden pt-2 text-center text-[11px] text-muted-foreground sm:block')],
              [review.revealed ? '1–4 to grade · U to undo' : 'Space to reveal'],
            ),
            // Keep the former hint's space reserved so revealing never moves
            // the grade controls, without showing the redundant instruction.
            h.p([h.Class('min-h-6 pt-2')], []),
          ],
        ),
      ],
    ),
  ]
}
