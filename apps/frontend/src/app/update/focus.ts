/**
 * Moves keyboard focus after a transition that removes the control that had it.
 */

import { Update } from 'foldkit'
import { FocusElement } from '../commands'
import { Message } from '../model'
import type { Model } from '../model'

/** The same transition, plus a focus move to `selector` after the next render. */
export const focusAfter = (
  result: Update.Return<Model, Message>,
  selector: string,
): Update.Return<Model, Message> => ({
  model: result.model,
  commands: [...(result.commands ?? []), FocusElement({ selector })],
})
