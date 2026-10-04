import type { Html, HtmlBuilder } from 'foldkit/html'

import { cn } from '@/lib/utils'

export type SeparatorOrientation = 'horizontal' | 'vertical'

export const separatorClass =
  'shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch'

type SeparatorConfig = Readonly<{
  orientation?: SeparatorOrientation
  className?: string
}>

/** Styled separator — a `role="separator"` divider. */
export const separator = <M>(config: SeparatorConfig, h: HtmlBuilder<M>): Html => {
  const orientation = config.orientation ?? 'horizontal'
  return h.div(
    [
      h.Class(cn(separatorClass, config.className)),
      h.Role('separator'),
      h.AriaOrientation(orientation),
      h.DataAttribute('slot', 'separator'),
      h.DataAttribute('orientation', orientation),
      h.DataAttribute(orientation, ''),
    ],
    [],
  )
}
