/**
 * Update: message → model transition, plus `init`.
 * Per-screen handlers live in `update/`; this file merges them.
 *
 * `init` parses the boot URL into the starting Route and seeds the Model;
 * `routeLoads` starts each screen's reads. The list and detail reads are
 * Queries, so `update` folds their Messages through a lifted fold and starts
 * them with `revalidateOrLoad`. A Query shows its own failure and Retry;
 * a `LoadFailed` answer — settings and the review queue — sets the notice.
 *
 * Settings edits write into `settingsDraft`; Save validates and applies that
 * draft optimistically, with the prior server value retained for rollback.
 */

import { Update } from 'foldkit'
import type { Url } from 'foldkit/url'
import { RestoreQueuedGrades } from './api-commands'
import { RestoreImportJob } from './import-commands'
import { RestoreQueries } from './query-commands'
import { Message, seedModel } from './model'
import type { Model } from './model'
import { appHandlers } from './update/app'
import { cardActionsHandlers } from './update/card-actions'
import { deckManageHandlers } from './update/deck-manage'
import { importHandlers } from './update/import'
import { routeLoads } from './update/loads'
import { noticeHandlers } from './update/notice'
import { restoreHandlers } from './update/restore'
import { reviewHandlers } from './update/review'
import { settingsHandlers } from './update/settings'
import { storyFeedHandlers } from './update/story-feed'

export const init = (url: Url): Update.Return<Model, Message> => {
  const loads = routeLoads(seedModel(url))
  return {
    model: loads.model,
    // An Import interrupted by a reload is still in IndexedDB; restore it so the
    // worker can pick it up again. Cached list answers reseed the Queries, so
    // a cold boot offline still shows the last data while the route loads run.
    commands: [
      ...(loads.commands ?? []),
      RestoreImportJob(),
      RestoreQueries(),
      RestoreQueuedGrades(),
    ],
  }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ...appHandlers(model),
    ...noticeHandlers(model),
    ...reviewHandlers(model),
    ...cardActionsHandlers(model),
    ...restoreHandlers(model),
    ...settingsHandlers(model),
    ...storyFeedHandlers(model),
    ...importHandlers(model),
    ...deckManageHandlers(model),
  })
