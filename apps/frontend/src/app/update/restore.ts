/**
 * Restore: replace the collection from a JSON export.
 */

import { Option } from 'effect'
import { Update } from 'foldkit'
import { PickRestoreFile, RestoreCollection } from '../api-commands'
import { Message, idleRestore } from '../model'
import type { Model } from '../model'
import { decks, overview } from './loads'
import { defineHandlers } from './handlers'

export const restoreHandlers = defineHandlers((model) => ({
  ClickedRestore: () => ({ model, commands: [PickRestoreFile()] }),

  CancelledRestoreSelect: () => ({ model }),

  // The file is only previewed: a dry run names what merging would add and
  // keep. Nothing is written until the Learner confirms.
  GotRestoreFile: ({ filename, json }) => ({
    model: {
      ...model,
      restore: { ...idleRestore, phase: 'reading', filename, json },
    },
    commands: [RestoreCollection({ json, dryRun: true })],
  }),

  PreviewedRestore: ({ result }) => ({
    model: {
      ...model,
      restore: { ...model.restore, phase: 'preview', result: Option.some(result) },
    },
  }),

  ClickedConfirmRestore: () =>
    model.restore.phase === 'preview'
      ? {
          model: { ...model, restore: { ...model.restore, phase: 'restoring' } },
          commands: [RestoreCollection({ json: model.restore.json, dryRun: false })],
        }
      : { model },

  // Restored decks and cards change every list the app caches, so the
  // overview and the deck list refetch now rather than on the next visit.
  RestoredCollection: ({ result }) =>
    Update.combine<Model, Message>(
      {
        ...model,
        restore: { ...model.restore, phase: 'done', json: '', result: Option.some(result) },
      },
      [overview.revalidate, decks.revalidate],
    ),

  RestoreFailed: ({ error, issues }) => ({
    model: {
      ...model,
      restore: { ...model.restore, phase: 'failed', json: '', error: Option.some(error), issues },
    },
  }),

  ClickedDismissRestore: () => ({ model: { ...model, restore: idleRestore } }),
}))
