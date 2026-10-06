/**
 * Settings hint tooltips: one Foldkit Tooltip submodel per hint slot.
 *
 * Each hint owns a Tooltip Model keyed by slot id (`model.hints[slot]`).
 * Messages arrive as `GotHintMessage({ slot, message })` and fold through the
 * matching entry; the tooltip's own OutMessage (Shown/Hidden) needs no parent
 * action, so the fold drops it. The `hint` view helper renders the `?`
 * trigger with the foldcn styled panel through `h.submodel`.
 */

import { Option } from 'effect'
import { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { CircleQuestionMark } from 'lucide'
import * as Tooltip from '@/components/ui/tooltip'
import { icon } from '@/lib/icons'
import { Message } from './model'
import type { HintSlot, Model } from './model'

/** Fold a tooltip message for one slot. Unknown slots are a no-op. */
export const foldHintMessage = (
  model: Model,
  slot: string,
  message: Tooltip.Message,
): Update.Return<Model, Message> =>
  Update.foldChild({
    update: (child: Tooltip.Model, input: Tooltip.Message) => Tooltip.update(child, input),
    read: (parent: Model) => Option.fromUndefinedOr(parent.hints[slot] ?? undefined),
    write: (parent, next) => ({ ...parent, hints: { ...parent.hints, [slot]: next } }),
    toParentMessage: (childMessage: Tooltip.Message): Message =>
      Message.GotHintMessage({ slot, message: childMessage }),
    foldOutMessage: () => (parent) => ({ model: parent }),
  })(model, message)

/**
 * A `?` trigger with its hint panel. The trigger is a ghost icon button;
 * the panel uses the foldcn tooltip style.
 */
export const hint = (slot: HintSlot, text: string, model: Model, h: HtmlBuilder<Message>): Html => {
  const child = model.hints[slot] ?? Tooltip.init({ id: `hint-${slot}` })
  return h.submodel({
    slotId: `hint-${slot}`,
    view: Tooltip.view,
    model: child,
    viewInputs: Tooltip.styledViewInputs<Message>(
      {
        trigger: icon(h, CircleQuestionMark, 'size-3.5'),
        content: text,
        triggerClass:
          'h-5 w-5 gap-0 rounded-full border-0 bg-transparent p-0 text-[var(--theme-sub)] hover:bg-transparent hover:text-[var(--theme-ink)]',
        triggerAttributes: [h.AriaLabel('About this setting')],
      },
      h,
    ),
    toParentMessage: (message) => Message.GotHintMessage({ slot, message }),
  })
}
