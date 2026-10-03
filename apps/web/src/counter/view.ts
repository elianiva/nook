/**
 * The counter view. One Foldkit `Card` from foldcn, with `Button`s for the
 * three server-side changes.
 */

import { Option } from 'effect'
import type { Document, HtmlBuilder } from 'foldkit/html'
import { button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Message } from './model'
import type { Model } from './model'

const countLabel = (model: Model): string =>
  Option.match(model.count, {
    onNone: () => '…',
    onSome: (count) => String(count),
  })

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'nook — a durable counter',
  body: h.div(
    [h.Class('flex min-h-svh items-center justify-center bg-background p-6 text-foreground')],
    [
      Card<Message>(
        { className: 'w-full max-w-sm' },
        [
          Card.header<Message>(
            {},
            [
              Card.title<Message>({}, ['Durable counter'], h),
              Card.description<Message>(
                {},
                ['The count lives in Cloudflare KV. Every change is a server-side RPC call.'],
                h,
              ),
            ],
            h,
          ),
          Card.content<Message>(
            {},
            [
              h.div(
                [h.Class('flex flex-col items-center gap-6')],
                [
                  h.div(
                    [h.Class('text-7xl font-semibold tracking-tight tabular-nums')],
                    [countLabel(model)],
                  ),
                  h.div(
                    [h.Class('flex items-center gap-2')],
                    [
                      button<Message>(
                        {
                          variant: 'outline',
                          size: 'icon-lg',
                          onClick: Message.ClickedDecrement(),
                          isDisabled: model.pending,
                        },
                        '−',
                        h,
                      ),
                      button<Message>(
                        {
                          variant: 'outline',
                          onClick: Message.ClickedReset(),
                          isDisabled: model.pending,
                        },
                        'Reset',
                        h,
                      ),
                      button<Message>(
                        {
                          size: 'icon-lg',
                          onClick: Message.ClickedIncrement(),
                          isDisabled: model.pending,
                        },
                        '+',
                        h,
                      ),
                    ],
                  ),
                  ...(Option.isSome(model.error)
                    ? [h.p([h.Class('text-sm text-destructive')], [model.error.value])]
                    : []),
                ],
              ),
            ],
            h,
          ),
          Card.footer<Message>(
            {},
            [
              h.span(
                [h.Class('text-xs text-muted-foreground')],
                ['Cloudflare KV · Workers RPC · nook.elianiva.com'],
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
