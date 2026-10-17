/**
 * Import: file pick, worker progress, and job restore.
 */

import { Option } from 'effect'
import { Update } from 'foldkit'
import { FocusElement } from '../commands'
import { ClearImportJob, PrepareImport } from '../import-commands'
import { Message, idleImport } from '../model'
import type { Model } from '../model'
import { decks } from './loads'
import { defineHandlers } from './handlers'

export const importHandlers = defineHandlers((model) => ({
  // The picker runs with no panel behind it: nothing shows until a file is
  // picked. `active` stays false, so no worker starts yet.
  ClickedImport: () => ({
    model,
    commands: [PrepareImport()],
  }),

  CancelledImportSelect: () => ({ model }),

  // The pick opens the detail panel; the preview worker reads what the
  // archive holds while it shows. Nothing writes until the Learner presses
  // Start. A failed preview lands the same way, on the panel.
  GotImportFile: ({ id, filename }) => ({
    model: {
      ...model,
      importState: {
        id: Option.some(id),
        filename,
        active: true,
        phase: 'preview',
        readStage: Option.none(),
        preview: Option.none(),
        includeMedia: true,
        includeHistory: false,
        status: Option.none(),
        error: Option.none(),
      },
    },
  }),

  GotImportPreview: ({ preview }) => ({
    commands: [FocusElement({ selector: '#import-start' })],
    model: {
      ...model,
      importState: {
        ...model.importState,
        // The preview worker answered, so it can tear down: `active` off
        // ends the subscription stream. Start turns it back on for the run.
        active: false,
        phase: 'preview',
        readStage: Option.none(),
        preview: Option.some(preview),
        error: Option.none(),
      },
    },
  }),

  ToggledImportMedia: ({ isChecked }) => ({
    model: {
      ...model,
      importState: { ...model.importState, includeMedia: isChecked },
    },
  }),

  ToggledImportHistory: ({ isChecked }) => ({
    model: {
      ...model,
      importState: { ...model.importState, includeHistory: isChecked },
    },
  }),

  // Start hands the run to the worker with the Learner's Media choice. The
  // subscription starts it because the phase moved, not because of a
  // Command here.
  ClickedStartImport: () =>
    model.importState.phase === 'preview' && Option.isSome(model.importState.id)
      ? {
          model: {
            ...model,
            importState: {
              ...model.importState,
              active: true,
              phase: 'running',
              readStage: Option.none(),
              status: Option.none(),
              error: Option.none(),
            },
          },
        }
      : { model },

  // A kept archive means an Import was interrupted. Resume it: the worker
  // calls `start` again and D1 returns the cursors it stopped at. Resume
  // past the detail panel: the pick already happened, and the preview would
  // only re-read what the run is about to write.
  RestoredImportJob: ({ job }) =>
    Option.match(job, {
      onNone: () => ({ model }),
      onSome: (restored) => ({
        model: {
          ...model,
          importState: {
            id: Option.some(restored.id),
            filename: restored.filename,
            active: true,
            phase: 'running',
            readStage: Option.none(),
            preview: Option.none(),
            includeMedia: true,
            includeHistory: false,
            status: Option.none(),
            error: Option.none(),
          },
        },
      }),
    }),

  ImportWorkerPhase: ({ phase }) => ({
    model: {
      ...model,
      importState: {
        ...model.importState,
        phase,
        // The read is over once the worker moves on; a retry starts it anew.
        readStage: phase === 'reading' ? model.importState.readStage : Option.none(),
      },
    },
  }),

  ReportedImportReadStage: ({ stage }) => ({
    model: {
      ...model,
      importState: { ...model.importState, readStage: Option.some(stage) },
    },
  }),

  ReportedImport: ({ progress }) => ({
    model: { ...model, importState: { ...model.importState, status: Option.some(progress) } },
  }),

  CompletedImport: ({ progress }) => {
    const next: Model = {
      ...model,
      importState: {
        id: Option.none(),
        filename: model.importState.filename,
        active: false,
        phase: 'done',
        readStage: Option.none(),
        preview: model.importState.preview,
        includeMedia: model.importState.includeMedia,
        includeHistory: model.importState.includeHistory,
        status: Option.some(progress),
        error: Option.none(),
      },
    }
    // The Decks page paints what the Import just wrote, and the archive is no
    // longer needed.
    return Update.combine<Model, Message>(next, [
      decks.revalidateOrLoad,
      (current) => ({ model: current, commands: [ClearImportJob()] }),
    ])
  },

  // The archive is kept, so Retry can resume without another file pick. A
  // failed preview keeps the detail panel, so the Learner can retry the
  // read or pick another file; a failed run keeps its cursors for Retry.
  FailedImport: ({ error }) =>
    model.importState.phase === 'preview'
      ? {
          model: {
            ...model,
            importState: {
              ...model.importState,
              active: false,
              preview: Option.none(),
              status: Option.none(),
              error: Option.some(error),
            },
          },
        }
      : {
          model: {
            ...model,
            importState: {
              ...model.importState,
              active: false,
              phase: 'failed',
              error: Option.some(error),
            },
          },
        },

  ClickedRetryImport: () =>
    Option.match(model.importState.id, {
      onNone: () => ({ model }),
      // A failed preview retries the read: back to waiting for the preview
      // worker, which the subscription starts. A failed run retries the run.
      onSome: () =>
        model.importState.phase === 'preview'
          ? {
              model: {
                ...model,
                importState: {
                  ...model.importState,
                  active: true,
                  preview: Option.none(),
                  readStage: Option.none(),
                  error: Option.none(),
                },
              },
            }
          : {
              model: {
                ...model,
                importState: {
                  ...model.importState,
                  active: true,
                  phase: 'running',
                  error: Option.none(),
                },
              },
            },
    }),

  // Stopping a run tears the worker down and forgets the archive, which is
  // what "active" going false makes the subscription do. The Import's cursors
  // stay in D1, so importing the same file again later resumes it.
  ClickedCancelImport: () => ({
    model: { ...model, importState: idleImport },
    commands: [ClearImportJob()],
  }),

  ClickedDismissImport: () => ({
    model: { ...model, importState: idleImport },
    commands: [ClearImportJob()],
  }),

  ClearedImportJob: () => ({ model }),
}))
