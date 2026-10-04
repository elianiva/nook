import { Switch as FoldkitSwitch } from '@foldkit/ui'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { cn } from '@/lib/utils'

/**
 * foldkit deltas (inlined at style resolution): foldkit emits aria-disabled/
 * data-disabled instead of native disabled, and only data-checked (never
 * data-unchecked) on the ROOT button — this view hand-emits data-unchecked
 * there when off. Upstream Base UI also puts data-checked/data-unchecked on
 * the THUMB itself (the travel/track variants like
 * group-data-[size=default]/switch:data-checked:* key on the thumb's own
 * attribute), so the thumb span mirrors the state attribute too.
 *
 */

export const switchSizeKeys = ['default', 'sm'] as const
export type SwitchSize = (typeof switchSizeKeys)[number]

/** Upstream switch component string; sizes come from the cn-switch token via
 *  the data-size attribute. */
export const switchClass =
  'data-checked:bg-primary data-unchecked:bg-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 dark:data-unchecked:bg-input/80 shrink-0 rounded-full border border-transparent focus-visible:ring-3 aria-invalid:ring-3 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:border-transparent data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] peer group/switch relative inline-flex items-center transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2 data-disabled:cursor-not-allowed data-disabled:opacity-50'

/** Upstream thumb string; geometry/travel come from the token keyed on
 *  group data-size + data-checked/data-unchecked. */
export const switchThumbClass =
  'bg-background dark:data-unchecked:bg-foreground dark:data-checked:bg-primary-foreground rounded-full group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0 pointer-events-none block ring-0 transition-transform'

export const switchLabelClass =
  'text-sm font-medium leading-none group-data-[disabled]/field:cursor-not-allowed group-data-[disabled]/field:opacity-70'

export const switchDescriptionClass = 'text-sm text-muted-foreground'

export const switchWrapperClass = 'group/field flex items-center gap-3'

export const switchTextWrapperClass = 'flex flex-col gap-1'

export type SwitchConfig<M> = Readonly<{
  id: string
  isChecked: boolean
  onToggle: (isChecked: boolean) => M
  label: string
  description?: string
  isDisabled?: boolean
  isReadOnly?: boolean
  name?: string
  value?: string
  size?: SwitchSize
  className?: string
  thumbClass?: string
  labelClass?: string
  descriptionClass?: string
  wrapperClass?: string
}>

/** Styled switch with label and optional description, built on the
 *  @foldkit/ui Switch helper. */
export const switch_ = <M>(config: SwitchConfig<M>, h: HtmlBuilder<M>): Html =>
  FoldkitSwitch.view<M>(
    {
      id: config.id,
      hasDescription: config.description !== undefined,
      isChecked: config.isChecked,
      onToggle: config.onToggle,
      isDisabled: config.isDisabled,
      isReadOnly: config.isReadOnly,
      name: config.name,
      value: config.value,
      toView: (attributes) =>
        h.div(
          [
            h.Class(cn(switchWrapperClass, config.wrapperClass)),
            ...(config.isDisabled ? [h.DataAttribute('disabled', '')] : []),
          ],
          [
            h.button(
              [
                ...attributes.button,
                h.DataAttribute('slot', 'switch'),
                h.DataAttribute('size', config.size ?? 'default'),
                ...(config.isChecked ? [] : [h.DataAttribute('unchecked', '')]),
                h.Class(cn(switchClass, config.className)),
              ],
              [
                h.span([
                  h.DataAttribute('slot', 'switch-thumb'),
                  h.DataAttribute(config.isChecked ? 'checked' : 'unchecked', ''),
                  h.Class(cn(switchThumbClass, config.thumbClass)),
                ]),
              ],
            ),
            ...(attributes.hiddenInput.length > 0 ? [h.input([...attributes.hiddenInput])] : []),
            h.div(
              [h.Class(switchTextWrapperClass)],
              [
                h.label(
                  [...attributes.label, h.Class(cn(switchLabelClass, config.labelClass))],
                  [config.label],
                ),
                config.description === undefined
                  ? h.empty
                  : h.p(
                      [
                        ...attributes.description,
                        h.Class(cn(switchDescriptionClass, config.descriptionClass)),
                      ],
                      [config.description],
                    ),
              ],
            ),
          ],
        ),
    },
    h,
  )
