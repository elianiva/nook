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
import { CircleAlert, Inbox, LoaderCircle, Search, Upload } from 'lucide'
import { Card } from '@/components/ui/card'
import { Empty } from '@/components/ui/empty'
import { input } from '@/components/ui/input'
import { button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { icon } from '@/lib/icons'
import type { DeckSummary } from '@nook/api'
import type { ImportProgress, ImportReadStage } from '@/lib/import-worker-protocol'
import { deckRow } from './home'
import { errorPanel, loadingPanel } from './load-state'
import { Message } from './model'
import type { Model } from './model'
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

  const stage = Option.match(state.readStage, {
    onNone: () => undefined,
    onSome: (value) => value,
  })

  const header = (() => {
    switch (state.phase) {
      case 'preparing':
        return { tone: 'text-muted-foreground', text: 'Choose an archive to import…' }
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
          button<Message>(
            { onClick: Message.ClickedRetryImport(), variant: 'outline', size: 'sm' },
            ['Retry'],
            h,
          ),
          button<Message>(
            { onClick: Message.ClickedDismissImport(), variant: 'ghost', size: 'sm' },
            ['Dismiss'],
            h,
          ),
        ]
      : state.phase === 'done'
        ? [
            button<Message>(
              { onClick: Message.ClickedDismissImport(), variant: 'ghost', size: 'sm' },
              ['Dismiss'],
              h,
            ),
          ]
        : state.active
          ? [
              button<Message>(
                { onClick: Message.ClickedCancelImport(), variant: 'ghost', size: 'sm' },
                ['Cancel'],
                h,
              ),
            ]
          : []

  return Card<Message>(
    { className: 'gap-2 p-3' },
    [
      h.div(
        [h.Class('flex items-center gap-2')],
        [
          icon(
            h,
            state.phase === 'failed' ? CircleAlert : state.phase === 'done' ? Upload : LoaderCircle,
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
    h,
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
            variant: 'outline',
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
      onEmpty: () => [loadingPanel('Loading decks…', h)],
      onFailure: (error) => [errorPanel(error, Message.ClickedRetryDecks(), h)],
      onData: (all) => deckList(all, model.decksQuery, h),
    }),
  ]
}
