import type { Html, HtmlBuilder } from 'foldkit/html'

type Child = Html | string

import { cn } from '@/lib/utils'

// Card is a pure layout primitive (no @foldkit/ui backing — there is no
// headless Card). `Card` itself is the container; sub-builders are attached
// as properties: Card.header, Card.title, Card.description, Card.action,
// Card.content, Card.footer.

export const cardSizeKeys = ['default', 'sm'] as const
export type CardSize = (typeof cardSizeKeys)[number]

export const cardClass =
  'ring-foreground/10 bg-card text-card-foreground gap-(--card-spacing) overflow-hidden rounded-xl py-(--card-spacing) text-sm ring-1 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl group/card flex flex-col'

export const cardHeaderClass =
  'gap-1 rounded-t-xl px-(--card-spacing) [.border-b]:pb-(--card-spacing) group/card-header @container/card-header grid auto-rows-min items-start has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto]'

export const cardTitleClass =
  'text-base leading-snug font-medium group-data-[size=sm]/card:text-sm font-heading'

export const cardDescriptionClass = 'text-muted-foreground text-sm'

export const cardContentClass = 'px-(--card-spacing)'

export const cardActionClass = 'col-start-2 row-span-2 row-start-1 self-start justify-self-end'

export const cardFooterClass =
  'bg-muted/50 rounded-b-xl border-t p-(--card-spacing) flex items-center'

type StyleConfig = Readonly<{ className?: string }>

type CardConfig = Readonly<{ className?: string; size?: CardSize }>

/** Outermost card surface. */
const cardContainer = <M>(
  config: CardConfig,
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<M>,
): Html =>
  h.div(
    [
      h.Class(cn(cardClass, config.className)),
      h.DataAttribute('slot', 'card'),
      h.DataAttribute('size', config.size ?? 'default'),
    ],
    children,
  )

/** Header wrapper — positions title, description and action via CSS grid. */
const cardHeader = <M>(
  config: StyleConfig,
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<M>,
): Html =>
  h.div(
    [h.Class(cn(cardHeaderClass, config.className)), h.DataAttribute('slot', 'card-header')],
    children,
  )

/** Card title. */
const cardTitle = <M>(
  config: StyleConfig,
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<M>,
): Html =>
  h.div(
    [h.Class(cn(cardTitleClass, config.className)), h.DataAttribute('slot', 'card-title')],
    children,
  )

/** Card description text. */
const cardDescription = <M>(
  config: StyleConfig,
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<M>,
): Html =>
  h.div(
    [
      h.Class(cn(cardDescriptionClass, config.className)),
      h.DataAttribute('slot', 'card-description'),
    ],
    children,
  )

/** Action area pinned to the top-right of the header. */
const cardAction = <M>(
  config: StyleConfig,
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<M>,
): Html =>
  h.div(
    [h.Class(cn(cardActionClass, config.className)), h.DataAttribute('slot', 'card-action')],
    children,
  )

/** Main content area. */
const cardContent = <M>(
  config: StyleConfig,
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<M>,
): Html =>
  h.div(
    [h.Class(cn(cardContentClass, config.className)), h.DataAttribute('slot', 'card-content')],
    children,
  )

/** Footer area. */
const cardFooter = <M>(
  config: StyleConfig,
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<M>,
): Html =>
  h.div(
    [h.Class(cn(cardFooterClass, config.className)), h.DataAttribute('slot', 'card-footer')],
    children,
  )

/** Composable card — `Card` is the container, with sub-builders as
 *  properties: `Card.header`, `Card.title`, `Card.description`,
 *  `Card.action`, `Card.content`, `Card.footer`. */
export const Card = Object.assign(cardContainer, {
  header: cardHeader,
  title: cardTitle,
  description: cardDescription,
  action: cardAction,
  content: cardContent,
  footer: cardFooter,
})
