/** A vertical, snap-by-snap Japanese story feed inside Nook's shared shell. */

import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { BookmarkPlus, Check, Sparkles, X } from 'lucide'
import { button } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import { Message } from './model'
import type { Model } from './model'
import { routeToUrl } from './routes'
import type { Story } from './stories/data'

type Child = Html | string

const storyHeader = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('sticky top-0 z-30 h-0 shrink-0 overflow-visible')],
    [
      h.div(
        [h.Class('flex items-center justify-between gap-2 px-5 pt-4 sm:px-6')],
        [
          h.a(
            [
              h.Href(routeToUrl({ _tag: 'Home' })),
              h.AriaLabel('Exit story scroll and return Home'),
              h.Class(
                'flex min-h-12 min-w-12 items-center gap-2 px-1 text-sm font-semibold text-[var(--theme-ink)] active:text-[var(--theme-strong)]',
              ),
            ],
            [icon(h, X, 'size-3.5'), 'Exit'],
          ),
          h.span(
            [
              h.Class(
                'flex items-center gap-1.5 text-[10px] font-extrabold tracking-[1.5px] text-[var(--theme-kicker)] uppercase',
              ),
            ],
            [icon(h, Sparkles, 'size-3.5 text-[var(--theme-strong)]'), 'For you'],
          ),
          h.span([h.Class('min-w-12')], []),
        ],
      ),
    ],
  )

const page = (h: HtmlBuilder<Message>, children: ReadonlyArray<Html>): Html =>
  h.div(
    [
      h.Class(
        'flex h-full w-full shrink-0 snap-center snap-always flex-col justify-center gap-3 px-5 pt-16 pr-20 pb-48 sm:px-6 sm:pr-20',
      ),
    ],
    children,
  )

const pageLabel = (h: HtmlBuilder<Message>, label: string): Html =>
  h.p(
    [h.Class('text-[11px] font-extrabold tracking-[1.5px] text-[var(--theme-kicker)] uppercase')],
    [label],
  )

const storyCard = (story: Story, model: Model, h: HtmlBuilder<Message>): Html => {
  const storyId = story.id
  const saved = model.storyFeed.savedStoryIds.includes(storyId)
  return h.article(
    [
      h.Id(`story-${storyId}`),
      h.Class(
        'relative isolate flex h-dvh snap-start snap-always flex-col overflow-hidden bg-[var(--theme-block)] [timeline-scope:--pages]',
      ),
    ],
    [
      h.div(
        [
          h.Class(
            'absolute inset-0 flex snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scroll-timeline:--pages_x] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          ),
        ],
        [
          page(h, [
            h.h2(
              [
                h.Class(
                  'text-[clamp(1.8rem,7vw,2.35rem)] leading-[1.7] font-medium text-[var(--theme-ink)] sm:text-[32px]',
                ),
                h.Lang('ja'),
              ],
              [story.passage],
            ),
          ]),
          page(h, [
            pageLabel(h, 'Translation'),
            h.p(
              [h.Class('text-2xl leading-relaxed font-medium text-[var(--theme-ink)]')],
              [story.translation],
            ),
          ]),
          page(h, [
            pageLabel(h, 'Word'),
            h.p(
              [h.Class('text-5xl font-medium text-[var(--theme-ink)]'), h.Lang('ja')],
              [story.word],
            ),
            h.p([h.Class('text-lg text-[var(--theme-sub)]'), h.Lang('ja')], [story.reading]),
            h.p([h.Class('text-2xl text-[var(--theme-ink)]')], [story.meaning]),
          ]),
        ],
      ),
      h.div(
        [
          h.Class(
            'pointer-events-none absolute inset-x-0 bottom-44 z-20 flex justify-center gap-3',
          ),
          h.AriaHidden(true),
        ],
        [0, 1, 2].map((dot) =>
          h.span(
            [h.Class(`story-page-dot-${dot} size-1.5 rounded-full bg-[var(--theme-strong)]`)],
            [],
          ),
        ),
      ),
      h.div(
        [
          h.Class(
            'pointer-events-none absolute bottom-5 left-5 z-10 max-w-[calc(100%-7.5rem)] sm:left-6',
          ),
        ],
        [
          h.p(
            [
              h.Class(
                'mb-1 text-[11px] font-extrabold tracking-[1.5px] text-[var(--theme-kicker)] uppercase',
              ),
            ],
            [story.tag],
          ),
          h.p(
            [h.Class('text-base leading-snug font-semibold text-[var(--theme-ink)]')],
            [story.caption],
          ),
          h.p(
            [h.Class('mt-2 text-xs text-[var(--theme-sub)]'), h.Lang('ja')],
            [`${story.word} · ${story.reading} · ${story.meaning}`],
          ),
        ],
      ),
      h.div(
        [h.Class('absolute right-3 bottom-14 z-20 flex flex-col items-center gap-3')],
        [
          h.div(
            [h.Class('flex flex-col items-center gap-1')],
            [
              button<Message>(
                {
                  onClick: Message.ToggledStorySave({ storyId }),
                  variant: 'ghost',
                  size: 'icon-lg',
                  className:
                    'size-16 rounded-none border-0 bg-transparent text-[var(--theme-ink)] shadow-none hover:bg-transparent hover:text-[var(--theme-strong)] active:scale-95',
                  attributes: [
                    h.AriaPressed(saved ? 'true' : 'false'),
                    h.AriaLabel(
                      `${saved ? 'Remove' : 'Save'} ${story.title} ${saved ? 'from' : 'as'} a flashcard`,
                    ),
                  ],
                },
                [icon(h, saved ? Check : BookmarkPlus, 'size-6')],
                h,
              ),
              h.span(
                [h.Class('text-[11px] font-medium text-[var(--theme-sub)]')],
                [saved ? 'Saved' : 'Save'],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

const fieldClass =
  'min-h-12 w-full border-b border-[var(--theme-sub)]/40 bg-transparent px-1 text-base text-[var(--theme-ink)] outline-none focus:border-[var(--theme-strong)]'

const generateCard = (model: Model, h: HtmlBuilder<Message>): Html => {
  const feed = model.storyFeed
  return h.form(
    [
      h.OnSubmit(Message.SubmittedStoryGeneration()),
      h.Class(
        'snap-start snap-always flex h-dvh flex-col justify-center gap-4 bg-[var(--theme-block)] px-6 py-10',
      ),
    ],
    [
      h.p([h.Class('text-sm font-bold text-[var(--theme-ink)]')], ['Generate more']),
      h.input([
        h.Type('text'),
        h.Value(feed.word),
        h.OnInput((value) => Message.EditedStoryWord({ value })),
        h.AriaLabel('Japanese word'),
        h.Placeholder('Japanese word, e.g. 余韻'),
        h.Lang('ja'),
        h.Class(fieldClass),
      ]),
      ...(Option.isSome(feed.generationError)
        ? [h.p([h.Class('text-xs text-[var(--theme-strong)]')], [feed.generationError.value])]
        : []),
      h.button(
        [
          h.Type('submit'),
          h.Class(
            'min-h-12 text-left text-sm font-bold text-[var(--theme-strong)] disabled:opacity-50',
          ),
        ],
        [feed.generating ? 'Generating…' : 'Generate 10 stories'],
      ),
    ],
  )
}

export const storiesView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Child> => [
  storyHeader(h),
  ...model.storyFeed.stories.map((story) => storyCard(story, model, h)),
  generateCard(model, h),
]
