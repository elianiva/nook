/**
 * Typing for the per-screen Message handlers that `update` merges.
 *
 * Each screen module returns a partial handler map for its own Messages;
 * `Message.match` in `update.ts` then checks the union of all maps covers every
 * Message.
 */

import type { Update } from 'foldkit'
import type { Message, Model } from '../model'

type Handlers = {
  readonly [Tag in Message['_tag']]: (
    message: Extract<Message, { _tag: Tag }>,
  ) => Update.Return<Model, Message>
}

export const defineHandlers = <H extends Partial<Handlers>>(make: (model: Model) => H) => make
