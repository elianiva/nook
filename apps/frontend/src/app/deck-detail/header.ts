/**
 * Deck page header: counts and the Start action.
 */

import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { Play } from 'lucide'
import { Progress } from '@/components/ui/progress'
import { button } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import type { DeckDetail } from '@nook/api'
import { Message } from '../model'

export const header = (detail: DeckDetail, h: HtmlBuilder<Message>): Html => {
  const today = detail.summary.dueToday + detail.summary.newToday
  const total = detail.summary.dueCount + detail.summary.newCount
  return h.div(
    [h.Class('rounded-[20px] border-0 bg-[var(--theme-block)] p-4')],
    [
      h.div(
        [h.Class('flex flex-col gap-1')],
        [
          h.h1([h.Class('text-lg font-bold tracking-tight')], [detail.summary.name]),
          h.p([h.Class('text-xs text-muted-foreground')], [detail.summary.description]),
        ],
      ),
      h.div(
        [h.Class('mt-3 grid grid-cols-3 gap-2 text-center')],
        [
          h.div(
            [h.Class('rounded-[10px] border-0 bg-white px-2 py-2')],
            [
              h.div(
                [h.Class('text-lg font-bold tabular-nums leading-none text-destructive')],
                [String(detail.summary.dueToday)],
              ),
              h.div([h.Class('mt-1 text-[11px] text-muted-foreground')], ['Due today']),
            ],
          ),
          h.div(
            [h.Class('rounded-[10px] border-0 bg-white px-2 py-2')],
            [
              h.div(
                [h.Class('text-lg font-bold tabular-nums leading-none')],
                [String(detail.summary.newToday)],
              ),
              h.div([h.Class('mt-1 text-[11px] text-muted-foreground')], ['New today']),
            ],
          ),
          h.div(
            [h.Class('rounded-[10px] border-0 bg-white px-2 py-2')],
            [
              h.div(
                [h.Class('text-lg font-bold tabular-nums leading-none')],
                [String(detail.summary.totalCount)],
              ),
              h.div([h.Class('mt-1 text-[11px] text-muted-foreground')], ['Total']),
            ],
          ),
        ],
      ),
      // The queue caps today by the limits; the sentence names the
      // remainder, so a Learner with 200 due and a 100 cap sees "100 today ·
      // 200 due in total" instead of thinking Cards vanished.
      ...(total === today
        ? []
        : [
            h.p(
              [h.Class('mt-2 text-center text-[11px] text-muted-foreground')],
              [`${today} today · ${total} due in total`],
            ),
          ]),
      h.div(
        [h.Class('mt-3 flex items-center gap-2')],
        [
          Progress<Message>(
            { value: detail.summary.retention7d, label: '7-day retention', className: 'flex-1' },
            h,
          ),
          h.span(
            [h.Class('text-xs tabular-nums text-muted-foreground')],
            [`${detail.summary.retention7d}% · 7d`],
          ),
        ],
      ),
      button<Message>(
        {
          onClick: Message.StartedReview({ deckId: Option.some(detail.summary.id) }),
          size: 'xl',
          className: 'mt-3 w-full',
          isDisabled: today === 0,
        },
        [
          icon(h, Play, 'size-4', 'inline-start'),
          today === 0 ? 'Nothing due today' : `Review ${today} Cards`,
        ],
        h,
      ),
    ],
  )
}
