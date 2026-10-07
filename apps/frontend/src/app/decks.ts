/**
 * Decks page: the full deck list with search and an import entry point.
 *
 * Each row is the same `DeckSummary` projection as on Home — counts plus the
 * next Review, never Card bodies. Search filters locally on name and
 * description; the backend will accept the same query string later.
 */

import { AsyncData } from 'foldkit'
import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { CircleAlert, Inbox, Search, Upload } from 'lucide'
import { Empty } from '@/components/ui/empty'
import { input } from '@/components/ui/input'
import { button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { switch_ } from '@/components/ui/switch'
import { icon } from '@/lib/icons'
import type { DeckSummary } from '@nook/api'
import type { ImportPreview, ImportProgress, ImportReadStage } from '@/lib/import-worker-protocol'
import { deckRow } from './home'
import { errorPanel, loadingRows } from './load-state'
import { Message } from './model'
import type { ImportState, Model } from './model'
import { decksQuery } from './queries'

type Child = Html | string

export const visibleDecks = (
  decks: ReadonlyArray<DeckSummary>,
  query: string,
): ReadonlyArray<DeckSummary> => {
  const needle = query.trim().toLowerCase()
  if (needle === '') return decks
  return decks.filter(
    (deck) =>
      deck.name.toLowerCase().includes(needle) || deck.description.toLowerCase().includes(needle),
  )
}

const formatCount = (count: number): string => count.toLocaleString()

/** Share of the archive's rows written so far, 0–100. An archive with no rows is done. */
const percentWritten = (progress: ImportProgress): number => {
  const total = progress.noteCount + progress.cardCount + progress.mediaCount
  if (total === 0) return 100
  return Math.round(
    ((progress.notesImported + progress.cardsImported + progress.mediaImported) / total) * 100,
  )
}

/** What the panel names while the archive opens, per step the worker reported. */
const readStageText = (stage: ImportReadStage | undefined, filename: string): string => {
  switch (stage) {
    case 'opening':
      return `Opening ${filename}…`
    case 'listing':
      return `Listing ${filename}…`
    case 'collection':
      return `Reading the collection in ${filename}…`
    case 'mediaIndex':
      return `Reading the media index in ${filename}…`
    case 'database':
      return `Opening the collection in ${filename}…`
    case 'manifest':
      return `Counting notes and cards in ${filename}…`
    default:
      return `Reading ${filename}…`
  }
}

/** Bytes as the panel shows them: `1.2 MB`, or `340 KB`, or the raw byte count. */
const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB'] as const
  let value = bytes / 1024
  let unit: (typeof units)[number] = 'KB'
  for (const next of units) {
    unit = next
    if (value < 1024 || next === 'GB') break
    value /= 1024
  }
  return `${value >= 100 ? Math.round(value).toString() : value.toFixed(1)} ${unit}`
}

/**
 * The Import detail panel, before anything is written.
 *
 * The preview worker reads what the archive holds while this shows: its
 * Decks, its Note Types, and its counts. The Learner includes or excludes
 * Media here — Media is the slow part — and presses Start to write. A failed
 * read keeps this panel with a Retry, so the Learner is never sent back to
 * the picker for a damaged archive they can simply re-pick.
 */
const importPreviewPanel = (state: ImportState, h: HtmlBuilder<Message>): Child => {
  const failed = Option.match(state.error, {
    onNone: () => null,
    onSome: (error) => error,
  })
  const waiting = Option.isNone(state.preview) && failed === null

  const stage = Option.match(state.readStage, {
    onNone: () => undefined,
    onSome: (value) => value,
  })

  const preview = Option.match(state.preview, {
    onNone: () => null,
    onSome: (value) => value,
  })

  const noteTypes = (value: ImportPreview): string =>
    value.noteTypes.length === 0
      ? 'No note types'
      : value.noteTypes.map((noteType) => `${noteType.name} (${noteType.templateCount})`).join(', ')

  return h.div(
    [h.Class('flex flex-col gap-2 rounded-[14px] border-0 bg-[var(--theme-block)] p-3')],
    [
      h.div(
        [h.Class('flex items-center gap-2')],
        [
          waiting
            ? h.span(
                [h.Class('size-4 shrink-0 animate-pulse rounded-[6px] bg-[var(--theme-bar-idle)]')],
                [],
              )
            : icon(
                h,
                failed === null ? Upload : CircleAlert,
                'size-4 shrink-0 text-muted-foreground',
              ),
          h.span(
            [h.Class('min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground')],
            [state.filename],
          ),
        ],
      ),
      ...(waiting
        ? [
            h.span(
              [h.Class('text-xs text-muted-foreground')],
              [readStageText(stage, state.filename)],
            ),
          ]
        : failed !== null
          ? [
              h.p([h.Class('text-xs text-destructive')], [failed]),
              h.div(
                [h.Class('flex gap-1 pt-1')],
                [
                  button<Message>(
                    { onClick: Message.ClickedRetryImport(), size: 'sm' },
                    ['Retry'],
                    h,
                  ),
                  button<Message>(
                    { onClick: Message.ClickedImport(), size: 'sm' },
                    ['Pick another file'],
                    h,
                  ),
                  button<Message>(
                    { onClick: Message.ClickedDismissImport(), size: 'sm' },
                    ['Dismiss'],
                    h,
                  ),
                ],
              ),
            ]
          : preview === null
            ? []
            : [
                h.span(
                  [h.Class('text-xs font-medium')],
                  [
                    `${formatCount(preview.noteCount)} notes · ${formatCount(preview.cardCount)} cards · ` +
                      `${formatCount(preview.mediaCount)} media${preview.mediaCount === 0 ? '' : ` (${formatBytes(preview.mediaBytes)})`}`,
                  ],
                ),
                h.span(
                  [h.Class('text-[11px] text-muted-foreground')],
                  [
                    preview.decks.length === 0
                      ? 'No decks'
                      : preview.decks.map((deck) => deck.name).join(', '),
                  ],
                ),
                h.span([h.Class('text-[11px] text-muted-foreground')], [noteTypes(preview)]),
                preview.mediaCount === 0
                  ? h.empty
                  : h.div(
                      [h.Class('py-1')],
                      [
                        switch_<Message>(
                          {
                            id: 'import-include-media',
                            label: `Include media (${formatCount(preview.mediaCount)} files, ${formatBytes(preview.mediaBytes)})`,
                            description: state.includeMedia
                              ? 'Media uploads with the import. Slow on large decks.'
                              : 'Cards import without their images and audio.',
                            isChecked: state.includeMedia,
                            onToggle: (isChecked) => Message.ToggledImportMedia({ isChecked }),
                            className: 'shrink-0 border-0 data-checked:bg-[var(--theme-tint)]',
                            labelClass: 'flex-1 text-[13px] font-semibold',
                            descriptionClass: 'text-[11px]',
                            wrapperClass: 'w-full flex-row-reverse justify-between gap-3',
                          },
                          h,
                        ),
                      ],
                    ),
                h.div(
                  [h.Class('flex gap-1 pt-1')],
                  [
                    button<Message>(
                      { onClick: Message.ClickedStartImport(), size: 'sm' },
                      ['Start import'],
                      h,
                    ),
                    button<Message>(
                      { onClick: Message.ClickedCancelImport(), size: 'sm' },
                      ['Cancel'],
                      h,
                    ),
                  ],
                ),
              ]),
    ],
  )
}

/**
 * The Import the Decks page is watching, or the last one it watched.
 *
 * While a run is in flight the numbers arrive from the Import worker, which
 * forwards the Worker's own counts after every batch, so the bar reflects what
 * is stored rather than what the browser has sent. A failed run keeps its
 * archive and its cursors, so Retry continues it without another file pick.
 */
const importPanel = (model: Model, h: HtmlBuilder<Message>): Child => {
  const state = model.importState
  if (state.phase === 'idle') return h.empty
  // The detail panel owns the pick: counts, Decks, Note Types, and the Media
  // choice. Nothing has run yet.
  if (state.phase === 'preview') return importPreviewPanel(state, h)

  const stage = Option.match(state.readStage, {
    onNone: () => undefined,
    onSome: (value) => value,
  })

  const header = (() => {
    switch (state.phase) {
      case 'running':
      case 'reading':
        return { tone: 'text-muted-foreground', text: readStageText(stage, state.filename) }
      case 'writing':
        return { tone: 'text-muted-foreground', text: `Importing ${state.filename}…` }
      case 'done':
        return { tone: 'text-primary', text: `Imported ${state.filename}` }
      case 'failed':
        return { tone: 'text-destructive', text: 'The import stopped' }
    }
  })()

  const failed = Option.match(state.error, {
    onNone: () => null,
    onSome: (error) => error,
  })

  const counts = Option.match(state.status, {
    onNone: () => null,
    onSome: (status) =>
      `${formatCount(status.notesImported)} of ${formatCount(status.noteCount)} notes · ` +
      `${formatCount(status.cardsImported)} of ${formatCount(status.cardCount)} cards`,
  })

  // Media now has a home in R2, so show how far it has come.
  const media = Option.match(state.status, {
    onNone: () => null,
    onSome: (status) =>
      status.mediaCount === 0
        ? null
        : `${formatCount(status.mediaImported)} of ${formatCount(status.mediaCount)} media`,
  })

  // A stopped Import keeps its archive, so Retry resumes it without another
  // file pick. A finished one only needs dismissing, and a running one can be
  // stopped.
  const actions: ReadonlyArray<Child> =
    state.phase === 'failed'
      ? [
          button<Message>({ onClick: Message.ClickedRetryImport(), size: 'sm' }, ['Retry'], h),
          button<Message>({ onClick: Message.ClickedDismissImport(), size: 'sm' }, ['Dismiss'], h),
        ]
      : state.phase === 'done'
        ? [button<Message>({ onClick: Message.ClickedDismissImport(), size: 'sm' }, ['Dismiss'], h)]
        : state.active
          ? [button<Message>({ onClick: Message.ClickedCancelImport(), size: 'sm' }, ['Cancel'], h)]
          : []

  return h.div(
    [h.Class('flex flex-col gap-2 rounded-[14px] border-0 bg-[var(--theme-block)] p-3')],
    [
      h.div(
        [h.Class('flex items-center gap-2')],
        [
          state.phase === 'running' || state.phase === 'reading' || state.phase === 'writing'
            ? h.span(
                [h.Class('size-4 shrink-0 animate-pulse rounded-[6px] bg-[var(--theme-bar-idle)]')],
                [],
              )
            : icon(
                h,
                state.phase === 'failed' ? CircleAlert : Upload,
                `size-4 shrink-0 ${header.tone}`,
              ),
          h.span(
            [h.Class(`min-w-0 flex-1 truncate text-xs font-medium ${header.tone}`)],
            [header.text],
          ),
        ],
      ),
      ...(state.phase === 'failed'
        ? [h.p([h.Class('text-xs text-destructive')], [failed ?? ''])]
        : [
            Progress<Message>(
              {
                value: Option.match(state.status, {
                  onNone: () => undefined,
                  onSome: percentWritten,
                }),
              },
              h,
            ),
            ...(counts === null
              ? []
              : [h.span([h.Class('text-[11px] text-muted-foreground')], [counts])]),
            ...(media === null
              ? []
              : [h.span([h.Class('text-[11px] text-muted-foreground')], [media])]),
          ]),
      ...(actions.length === 0 ? [] : [h.div([h.Class('flex gap-1 pt-1')], actions)]),
    ],
  )
}

const deckList = (
  all: ReadonlyArray<DeckSummary>,
  query: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Child> => {
  const decks = visibleDecks(all, query)
  return [
    h.div(
      [h.Class('text-xs text-muted-foreground')],
      [
        `${decks.length} of ${all.length} decks · ${all.reduce((sum, deck) => sum + deck.dueCount, 0)} due total`,
      ],
    ),
    ...(decks.length === 0
      ? [
          Empty<Message>(
            {},
            [
              Empty.media<Message>({ variant: 'icon' }, [icon(h, Inbox, 'size-4')], h),
              Empty.title<Message>(
                {},
                [all.length === 0 ? 'No decks yet' : 'No matching decks'],
                h,
              ),
              Empty.description<Message>(
                {},
                [
                  all.length === 0
                    ? 'Import an .apkg archive to start reviewing.'
                    : `Nothing matches “${query.trim()}”.`,
                ],
                h,
              ),
            ],
            h,
          ),
        ]
      : decks.map((deck) => deckRow(deck, h))),
  ]
}

export const decksView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Child> => {
  const decksAsync = decksQuery.read(model.decks)
  return [
    h.div(
      [h.Class('flex gap-2')],
      [
        h.div(
          [h.Class('relative flex-1')],
          [
            h.div(
              [
                h.Class(
                  'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground',
                ),
              ],
              [icon(h, Search, 'size-4')],
            ),
            input<Message>(
              {
                id: 'decks-search',
                label: 'Search decks',
                labelClass: 'sr-only',
                wrapperClass: 'gap-0',
                placeholder: 'Search decks…',
                value: model.decksQuery,
                onInput: (value) => Message.TypedDecksQuery({ value }),
                className:
                  'h-11 rounded-[14px] border-0 bg-[var(--theme-block)] pl-9 text-base shadow-none',
              },
              h,
            ),
          ],
        ),
        button<Message>(
          {
            onClick: Message.ClickedImport(),
            isDisabled: model.importState.active,
            size: 'icon-lg',
            className: 'h-11 w-11 rounded-[14px] border-0 bg-[var(--theme-block)] shadow-none',
            attributes: [h.AriaLabel('Import deck')],
          },
          [icon(h, Upload, 'size-4')],
          h,
        ),
      ],
    ),
    importPanel(model, h),
    ...AsyncData.matchData(decksAsync, {
      onEmpty: () => [loadingRows('Loading decks…', h)],
      onFailure: (error) => [errorPanel(error, Message.ClickedRetryDecks(), h)],
      onData: (all) => deckList(all, model.decksQuery, h),
    }),
  ]
}
