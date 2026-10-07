/**
 * The two read states a Query-backed screen shows besides data: a request in
 * flight, and a failure with its Retry.
 *
 * Loading renders as a skeleton: solid `--theme-block` shapes that hold the
 * shape of the content to come — no spinners, no bordered panels.
 *
 * A failure is local to the slice that failed, so the Learner sees what did not
 * load and can retry just that read instead of the whole screen.
 */

import type { Html, HtmlBuilder } from 'foldkit/html'
import { CircleAlert, RotateCcw } from 'lucide'
import { button } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import type { Message } from './model'

/** One pulsing bar: a solid `--theme-block` block with a fixed height. */
const skeletonBar = (className: string, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class(`animate-pulse rounded-[12px] bg-[var(--theme-block)] ${className}`)], [])

/** A hero-only skeleton for a summary slice such as the Home overview. */
export const loadingHero = (label: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-2'), h.Role('status'), h.AriaLabel(label)],
    [h.span([h.Class('sr-only')], [label]), skeletonBar('h-[168px] w-full rounded-[20px]', h)],
  )

/** Row-only skeletons for a list slice such as the deck list. */
export const loadingRows = (label: string, h: HtmlBuilder<Message>, rows = 3): Html =>
  h.div(
    [h.Class('flex flex-col gap-2'), h.Role('status'), h.AriaLabel(label)],
    [h.span([h.Class('sr-only')], [label]), ...rowShapes(rows, h)],
  )

/** One deck-row shape: avatar block, two text lines, and a count block. */
const rowShapes = (rows: number, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Array.from({ length: rows }, () =>
    h.div(
      [h.Class('flex items-center gap-3 rounded-[14px] bg-[var(--theme-block)] p-3')],
      [
        skeletonBar('size-10 shrink-0 rounded-xl', h),
        h.div(
          [h.Class('flex min-w-0 flex-1 flex-col gap-1.5')],
          [skeletonBar('h-3.5 w-2/3', h), skeletonBar('h-3 w-1/2', h)],
        ),
        skeletonBar('h-6 w-8 shrink-0', h),
      ],
    ),
  )

/** A panel for the `Failure` state: the message, and the read to run again. */
export const errorPanel = (message: string, onRetry: Message, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        'flex flex-col items-center gap-3 rounded-[14px] border-0 bg-[var(--theme-block)] px-4 py-6 text-center',
      ),
    ],
    [
      h.div(
        [h.Class('flex flex-col items-center gap-3 text-center'), h.Role('alert')],
        [
          icon(h, CircleAlert, 'size-5 text-[var(--theme-strong)]'),
          h.p([h.Class('max-w-64 text-xs text-[var(--theme-ink)]')], [message]),
          button<Message>(
            { onClick: onRetry, size: 'sm' },
            [icon(h, RotateCcw, 'size-3.5'), 'Retry'],
            h,
          ),
        ],
      ),
    ],
  )

/** A form-validation banner: the message on a white card. No retry — fixing the input clears it. */
export const fieldError = (message: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        'flex items-start gap-2 rounded-[10px] border-0 bg-white px-3 py-2 text-xs text-destructive',
      ),
      h.Role('alert'),
    ],
    [icon(h, CircleAlert, 'size-4 shrink-0'), h.span([], [message])],
  )
