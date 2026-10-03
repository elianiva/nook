/**
 * The app shell's view. It states what nook is and reports whether the Worker
 * answered. The first real feature replaces this with the review screen.
 */

import { Option } from 'effect'
import type { Document, HtmlBuilder } from 'foldkit/html'
import { Card } from '@/components/ui/card'
import type { Model } from './model'
import { Message } from './model'

const status = (model: Model): string =>
  Option.match(model.online, {
    onNone: () => 'checking the Worker…',
    onSome: (online) => (online ? 'Worker reachable' : 'Worker unreachable'),
  })

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'nook',
  body: h.div(
    [h.Class('flex min-h-svh items-center justify-center bg-background p-6 text-foreground')],
    [
      Card<Message>(
        { className: 'w-full max-w-sm' },
        [
          Card.header<Message>(
            {},
            [
              Card.title<Message>({}, ['nook'], h),
              Card.description<Message>(
                {},
                ['A spaced repetition system. Import an Anki deck, then review.'],
                h,
              ),
            ],
            h,
          ),
          Card.content<Message>(
            {},
            [
              h.div(
                [h.Class('text-xs text-muted-foreground')],
                [
                  status(model),
                  ...(Option.isSome(model.detail)
                    ? [h.div([h.Class('text-xs text-destructive')], [model.detail.value])]
                    : []),
                ],
              ),
            ],
            h,
          ),
        ],
        h,
      ),
    ],
  ),
})
