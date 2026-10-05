/**
 * The two read states a Query-backed screen shows besides data: a request in
 * flight, and a failure with its Retry.
 *
 * A failure is local to the slice that failed, so the Learner sees what did not
 * load and can retry just that read instead of the whole screen.
 */

import type { Html, HtmlBuilder } from 'foldkit/html'
import { CircleAlert, LoaderCircle, RotateCcw } from 'lucide'
import { button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { icon } from '@/lib/icons'
import type { Message } from './model'

/** A panel for the `Idle` and `Loading` states: the read has not answered yet. */
export const loadingPanel = (label: string, h: HtmlBuilder<Message>): Html =>
  Card<Message>(
    { className: 'items-center' },
    [
      h.div(
        [h.Class('flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground')],
        [icon(h, LoaderCircle, 'size-4 animate-spin'), label],
      ),
    ],
    h,
  )

/** A panel for the `Failure` state: the message, and the read to run again. */
export const errorPanel = (message: string, onRetry: Message, h: HtmlBuilder<Message>): Html =>
  Card<Message>(
    { className: 'items-center border-destructive/40' },
    [
      h.div(
        [h.Class('flex flex-col items-center gap-3 py-6 text-center'), h.Role('alert')],
        [
          icon(h, CircleAlert, 'size-5 text-destructive'),
          h.p([h.Class('max-w-64 text-xs text-destructive')], [message]),
          button<Message>(
            { onClick: onRetry, variant: 'outline', size: 'sm' },
            [icon(h, RotateCcw, 'size-3.5'), 'Retry'],
            h,
          ),
        ],
      ),
    ],
    h,
  )
