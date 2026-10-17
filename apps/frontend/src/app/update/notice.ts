/**
 * The notice banner: failures set it and its Retry reruns the failed read or save.
 */

import { Option } from 'effect'
import { modifyFields } from 'foldkit/struct'
import {
  FetchExport,
  FetchReviewQueue,
  FetchSettings,
  LoadCachedQueue,
  RestoreQueuedGrades,
  SaveSettings,
  UndoGrade,
} from '../api-commands'
import type { LoadRetry } from '../model'
import type { Model } from '../model'
import { beginSettingsSave, settingsFromDraft } from './settings'
import { defineHandlers } from './handlers'

/** The fetch or save the notice retry runs, rebuilt from the current route and draft. */
export const retryCommandsFor = (model: Model, retry: LoadRetry) => {
  switch (retry) {
    case 'reviewQueue': {
      const route = model.route
      if (route._tag === 'ReviewDeck') {
        return [
          LoadCachedQueue({
            deckId: Option.some(route.deckId),
            sessionId: model.review.queueSessionId,
          }),
          FetchReviewQueue({
            deckId: Option.some(route.deckId),
            bypassDueLimit: model.review.bypassDueLimit,
            sessionId: model.review.queueSessionId,
          }),
        ]
      }
      return [
        LoadCachedQueue({ deckId: Option.none(), sessionId: model.review.queueSessionId }),
        FetchReviewQueue({
          deckId: Option.none(),
          bypassDueLimit: model.review.bypassDueLimit,
          sessionId: model.review.queueSessionId,
        }),
      ]
    }
    case 'settings':
      return [FetchSettings()]
    case 'saveSettings':
      return [SaveSettings({ settings: settingsFromDraft(model) })]
    case 'queuedGrades':
      return [RestoreQueuedGrades()]
    case 'undoReview': {
      const last = model.review.lastGrade
      if (Option.isNone(last)) return []
      return [UndoGrade({ cardId: last.value.cardId, reviewId: last.value.id })]
    }
    case 'collectionExport':
      return [FetchExport()]
  }
}

export const clearNotice = (model: Model): Model => ({ ...model, notice: Option.none() })

export const noticeHandlers = defineHandlers((model) => ({
  LoadFailed: ({ error, retry, sessionId }) => {
    if (
      retry === 'reviewQueue' &&
      sessionId !== undefined &&
      sessionId !== model.review.queueSessionId
    ) {
      return { model }
    }
    let next = model
    if (retry === 'saveSettings' && Option.isSome(model.settingsRollback)) {
      next = {
        ...model,
        settings: model.settingsRollback.value,
        settingsRollback: Option.none(),
        settingsDraft: { ...model.settingsDraft, saving: false },
      }
    }
    return {
      model: modifyFields(next, {
        notice: () => Option.some({ message: error, retry }),
        ...(retry === 'reviewQueue'
          ? {
              review: () => ({
                ...model.review,
                queueStatus: 'offline' as const,
                phase:
                  model.review.bypassDueLimit ||
                  (model.review.phase === 'loading' && model.review.cards.length === 0)
                    ? ('done' as const)
                    : model.review.phase,
              }),
            }
          : {}),
      }),
    }
  },

  ClickedRetry: () =>
    Option.match(model.notice, {
      onNone: () => ({ model }),
      onSome: (notice) =>
        notice.retry === 'saveSettings'
          ? {
              model: beginSettingsSave(model),
              commands: [SaveSettings({ settings: settingsFromDraft(model) })],
            }
          : {
              model:
                notice.retry === 'reviewQueue'
                  ? modifyFields(clearNotice(model), {
                      review: () => ({ ...model.review, queueStatus: 'loading' }),
                    })
                  : model,
              commands: retryCommandsFor(model, notice.retry),
            },
    }),
}))
