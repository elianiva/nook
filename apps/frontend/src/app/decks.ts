/**
 * Decks page: sections plus a dark Import footer.
 *
 * Decks with reviews due group into a `Needs attention` basket; clean decks
 * stay in a plain `Up to date` grid. Each card links to its own deck page.
 * The Import entry ends the page as one dark footer button, and the Import
 * panel shows above the sections while a run is in flight.
 */

import { AsyncData } from 'foldkit'
import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { ChevronRight, CircleAlert, Inbox, Plus, Upload } from 'lucide'
import { Empty } from '@/components/ui/empty'
import { button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { switch_ } from '@/components/ui/switch'
import { icon } from '@/lib/icons'
import type { DeckSummary } from '@nook/api'
import type { ImportPreview, ImportProgress, ImportReadStage } from '@/lib/import-worker-protocol'
import { lastStudied } from './home'
import { errorPanel, loadingRows } from './load-state'
import { Message } from './model'
import type { ImportState, Model } from './model'
import { decksQuery } from './queries'
import { routeToUrl } from './routes'

type Child = Html | string

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

const sectionHead = (label: string, h: HtmlBuilder<Message>): Html =>
  h.h2(
    [h.Class('mt-1.5 text-xs font-bold tracking-[1.2px] text-muted-foreground uppercase')],
    [label],
  )

/** One deck card. Due decks get white cards with a pink pill; clean decks stay grey. */
const deckCard = (deck: DeckSummary, variant: 'due' | 'clean', h: HtmlBuilder<Message>): Html => {
  const initial = deck.name.trim().charAt(0) || '?'
  return h.a(
    [
      h.Href(routeToUrl({ _tag: 'DeckDetail', deckId: deck.id })),
      // Hover and keyboard focus warm the detail Query, so the deck page
      // opens with data while its refresh runs.
      h.OnMouseEnter(Message.PrefetchedDeckDetail({ deckId: deck.id })),
      h.OnFocus(Message.PrefetchedDeckDetail({ deckId: deck.id })),
    ],
    [
      h.div(
        [
          h.Class(
            variant === 'due'
              ? 'flex min-w-0 flex-col gap-1.5 rounded-[16px] border-0 bg-white p-3'
              : 'flex min-w-0 flex-col gap-1.5 rounded-[16px] border-0 bg-[var(--theme-block)] p-3',
          ),
        ],
        [
          h.div(
            [
              h.Class(
                variant === 'due'
                  ? 'flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[var(--theme-block)] text-sm font-extrabold text-[var(--theme-ink)]'
                  : 'flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-white text-sm font-extrabold text-[var(--theme-ink)]',
              ),
            ],
            [initial],
          ),
          h.div([h.Class('truncate text-[13px] font-bold')], [deck.name]),
          h.div(
            [h.Class('text-[11px] text-[var(--theme-sub)]')],
            [`${deck.dueCount} due · ${deck.newCount} new`],
          ),
          ...(variant === 'due'
            ? [
                Progress<Message>(
                  {
                    value: deck.retention7d,
                    className:
                      'mt-1 [&_[data-slot=progress-track]]:h-[5px] [&_[data-slot=progress-track]]:bg-[var(--theme-bar-idle)] [&_[data-slot=progress-indicator]]:bg-[var(--theme-tint)]',
                  },
                  h,
                ),
              ]
            : []),
          h.div(
            [h.Class('mt-0.5 flex items-center justify-between')],
            [
              h.span(
                [
                  h.Class(
                    variant === 'due'
                      ? 'rounded-full bg-[var(--theme-tint)] px-2 py-0.5 text-[11px] font-extrabold text-[var(--theme-ink)] tabular-nums'
                      : 'rounded-full bg-[var(--theme-bar-idle)] px-2 py-0.5 text-[11px] font-extrabold text-[var(--theme-sub)] tabular-nums',
                  ),
                ],
                [`${deck.dueCount} due`],
              ),
              icon(h, ChevronRight, 'size-4 text-[var(--theme-sub)]'),
            ],
          ),
          ...(variant === 'clean'
            ? [h.div([h.Class('text-[11px] text-[var(--theme-sub)]')], [lastStudied(deck)])]
            : []),
        ],
      ),
    ],
  )
}

/** The Import entry: one dark footer button that ends the page. */
const importFooter = (model: Model, h: HtmlBuilder<Message>): Html =>
  button<Message>(
    {
      onClick: Message.ClickedImport(),
      isDisabled: model.importState.active,
      size: 'lg',
      className:
        'h-12 w-full rounded-[14px] bg-[var(--theme-ink)] text-sm font-bold text-white shadow-none hover:bg-[var(--theme-ink)]/90',
      attributes: [h.AriaLabel('Import deck')],
    },
    [icon(h, Plus, 'size-4'), 'Import a deck…'],
    h,
  )

const deckSections = (
  all: ReadonlyArray<DeckSummary>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Child> => {
  const due = all.filter((deck) => deck.dueCount > 0)
  const clean = all.filter((deck) => deck.dueCount === 0)
  return [
    ...(due.length === 0
      ? []
      : [
          sectionHead('Needs attention', h),
          h.div(
            [h.Class('flex flex-col gap-2.5 rounded-[18px] border-0 bg-[var(--theme-block)] p-3')],
            [
              h.div(
                [h.Class('grid grid-cols-2 gap-2.5')],
                due.map((deck) => deckCard(deck, 'due', h)),
              ),
            ],
          ),
        ]),
    ...(clean.length === 0
      ? []
      : [
          sectionHead('Up to date', h),
          h.div(
            [h.Class('grid grid-cols-2 gap-2.5')],
            clean.map((deck) => deckCard(deck, 'clean', h)),
          ),
        ]),
  ]
}

const deckList = (
  all: ReadonlyArray<DeckSummary>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Child> => {
  if (all.length === 0) {
    return [
      Empty<Message>(
        {},
        [
          Empty.media<Message>({ variant: 'icon' }, [icon(h, Inbox, 'size-4')], h),
          Empty.title<Message>({}, ['No decks yet'], h),
          Empty.description<Message>({}, ['Import an .apkg archive to start reviewing.'], h),
        ],
        h,
      ),
    ]
  }
  return deckSections(all, h)
}

export const decksView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Child> => {
  const decksAsync = decksQuery.read(model.decks)
  return [
    importPanel(model, h),
    ...AsyncData.matchData(decksAsync, {
      onEmpty: () => [loadingRows('Loading decks…', h)],
      onFailure: (error) => [errorPanel(error, Message.ClickedRetryDecks(), h)],
      onData: (all) => [...deckList(all, h), importFooter(model, h)],
    }),
  ]
}
