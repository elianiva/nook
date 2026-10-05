/**
 * Settings page: FSRS knobs, deck defaults, and behaviour.
 *
 * Sections, top to bottom:
 * 1. FSRS scheduling — desired retention, weights (advanced), maximum
 *    interval
 * 2. Deck defaults — new Cards and reviews per day, lapse minutes
 * 3. Behaviour — review sounds, tap-to-reveal, day rollover, keep-awake
 *
 * Every field edits a local draft; Save validates the whole form and sends
 * it through the save Command — the view does not change.
 *
 * Appearance sits above the form and outside the draft: picking a Mochi
 * swatch sends `PickedTheme`, which writes `data-theme` and localStorage at
 * once, so the dashboard and settings re-tint without a save.
 *
 * Mobile layout: each row is a stacked label-over-control pair, never a
 * side-by-side label/input pair. A 390px phone gives ~340px of card content
 * width, and a 96px-wide number input next to its label squeezes the label
 * into a tall wrapped column with a clipped input. Chrome on Android also
 * zooms the page when a sub-16px input takes focus, which breaks the narrow
 * shell frame — every text control here sets 16px text so focus never zooms.
 */

import { Option } from 'effect'
import type { Attribute, Html, HtmlBuilder } from 'foldkit/html'
import { CircleAlert, Download, RotateCcw, Save } from 'lucide'
import { nativeSelect, nativeSelectOption } from '@/components/ui/native-select'
import { separator } from '@/components/ui/separator'
import { switch_ } from '@/components/ui/switch'
import { textarea } from '@/components/ui/textarea'
import { button } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import { readTheme, themeKeys, themeMeta } from '@/lib/theme'
import { Message } from './model'
import type { Model, SettingsDraft } from './model'

type Child = Html | string

const section = (
  title: string,
  description: string,
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-2.5')],
    [
      h.span(
        [h.Class('text-[11px] font-bold tracking-[2.2px] text-[var(--theme-sub)] uppercase')],
        [title],
      ),
      h.p([h.Class('text-xs leading-relaxed text-[var(--theme-sub)]')], [description]),
      ...children,
    ],
  )

/**
 * One settings row: a borderless `--theme-block` field with an ink label, a
 * muted hint, and a white control. The mockups render every number input,
 * select, and toggle as its own block; the weights textarea keeps the same
 * treatment so the form reads as one rhythm.
 */
const fieldBlockClass = 'flex flex-col gap-2 rounded-[14px] border-0 bg-[var(--theme-block)] p-3.5'

const fieldLabelClass = 'text-[13px] font-semibold leading-none'
const fieldHintClass = 'text-xs leading-relaxed text-[var(--theme-sub)]'

/** White control inside a field block: no outline, ink text, 16px text. */
const fieldControlClass =
  'rounded-[10px] border-0 bg-white font-semibold text-[var(--theme-ink)] shadow-none tabular-nums outline-none'

const fieldHeader = (
  id: string,
  labelText: string,
  description: string | undefined,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-1')],
    [
      h.label([h.For(id), h.Class(fieldLabelClass)], [labelText]),
      ...(description === undefined ? [] : [h.p([h.Class(fieldHintClass)], [description])]),
    ],
  )

/** Shared number-input classes: full width, 16px text so mobile focus never zooms. */
const numberInputClass =
  'h-10 w-full px-3 py-2 text-base transition-colors placeholder:text-[var(--theme-sub)] ' +
  fieldControlClass

const numberField = (
  id: string,
  labelText: string,
  value: number,
  toMessage: (value: string) => Message,
  description: string | undefined,
  step: string,
  extra: Readonly<{
    min?: string
    max?: string
    inputMode?: string
    hintId?: string
  }>,
  h: HtmlBuilder<Message>,
): Html => {
  const describedBy: ReadonlyArray<Attribute<Message>> =
    extra.hintId === undefined ? [] : [h.AriaDescribedBy(extra.hintId)]
  return h.div(
    [h.Class(fieldBlockClass)],
    [
      fieldHeader(id, labelText, description, h),
      h.input([
        h.Id(id),
        h.Type('number'),
        h.Value(String(value)),
        h.OnInput(toMessage),
        h.Step(step),
        ...(extra.min === undefined ? [] : [h.Min(extra.min)]),
        ...(extra.max === undefined ? [] : [h.Max(extra.max)]),
        ...(extra.inputMode === undefined ? [] : [h.InputMode(extra.inputMode)]),
        ...describedBy,
        h.Class(numberInputClass),
      ]),
    ],
  )
}

const fsrsSection = (draft: SettingsDraft, h: HtmlBuilder<Message>): Html =>
  section(
    'FSRS scheduling',
    'How the scheduler spaces Reviews. Stability and difficulty stay with FSRS — these are the only dials.',
    [
      numberField(
        'desired-retention',
        'Desired retention',
        draft.desiredRetention,
        (value) => Message.EditedRetention({ value }),
        'Target recall rate, 0.70–0.95',
        '0.01',
        { min: '0.7', max: '0.95', inputMode: 'decimal', hintId: 'desired-retention-hint' },
        h,
      ),
      textarea<Message>(
        {
          id: 'fsrs-weights',
          label: 'FSRS weights (advanced)',
          description: '21 comma-separated values for FSRS-6. Wrong count blocks save.',
          value: draft.weightsText,
          onInput: (value) => Message.EditedWeights({ value }),
          rows: 3,
          wrapperClass: fieldBlockClass,
          labelClass: 'text-[13px] font-semibold leading-none',
          descriptionClass: 'text-xs text-[var(--theme-sub)]',
          className: 'border-0 bg-white font-semibold shadow-none outline-none md:text-sm',
        },
        h,
      ),
      numberField(
        'maximum-interval',
        'Maximum interval',
        draft.maximumInterval,
        (value) => Message.EditedMaximumInterval({ value }),
        'Cap on any interval, in days',
        '1',
        { min: '1', inputMode: 'numeric' },
        h,
      ),
    ],
    h,
  )

const defaultsSection = (draft: SettingsDraft, h: HtmlBuilder<Message>): Html =>
  section(
    'Deck defaults',
    'Daily limits for every deck unless a deck overrides them later.',
    [
      numberField(
        'new-per-day',
        'New Cards per day',
        draft.newPerDay,
        (value) => Message.EditedNewPerDay({ value }),
        undefined,
        '1',
        { min: '0', inputMode: 'numeric' },
        h,
      ),
      numberField(
        'reviews-per-day',
        'Reviews per day',
        draft.reviewsPerDay,
        (value) => Message.EditedReviewsPerDay({ value }),
        undefined,
        '1',
        { min: '0', inputMode: 'numeric' },
        h,
      ),
      numberField(
        'lapse-minutes',
        'Lapse minutes',
        draft.lapseMinutes,
        (value) => Message.EditedLapseMinutes({ value }),
        'Minutes before an Again Card returns this session',
        '1',
        { min: '1', inputMode: 'numeric' },
        h,
      ),
    ],
    h,
  )

const rolloverOptions = Array.from({ length: 24 }, (_, hour) => `${hour}:00`)

const behaviourSection = (draft: SettingsDraft, h: HtmlBuilder<Message>): Html =>
  section(
    'Behaviour',
    'What review sessions feel like and when the day rolls over.',
    [
      h.div(
        [h.Class(fieldBlockClass)],
        [
          switch_<Message>(
            {
              id: 'tap-to-reveal',
              label: 'Tap anywhere to reveal',
              description: 'Reveal the answer with a tap, not just the button',
              isChecked: draft.tapToReveal,
              onToggle: (isChecked) => Message.ToggledTapToReveal({ isChecked }),
              className: 'border-0 data-checked:bg-[var(--theme-tint)]',
              labelClass: 'text-[13px] font-semibold leading-none',
              descriptionClass: 'text-xs text-[var(--theme-sub)]',
            },
            h,
          ),
        ],
      ),
      h.div(
        [h.Class(fieldBlockClass)],
        [
          h.div(
            [h.Class('flex flex-col gap-1')],
            [
              h.label([h.For('rollover-hour'), h.Class(fieldLabelClass)], ['Day rollover']),
              h.p(
                [h.Class(fieldHintClass)],
                ['When today ends: reviews before this hour count toward yesterday'],
              ),
            ],
          ),
          nativeSelect<Message>(
            {
              id: 'rollover-hour',
              label: 'Day rollover',
              value: `${draft.dayRolloverHour}:00`,
              onChange: (value) =>
                Message.EditedRolloverHour({ value: value.split(':')[0] ?? '4' }),
              options: rolloverOptions.map((option) =>
                nativeSelectOption<Message>({ value: option, label: option }, h),
              ),
              labelClass: 'sr-only',
              className: 'h-10 border-0 bg-white font-semibold shadow-none outline-none',
              descriptionClass: 'text-xs text-[var(--theme-sub)]',
            },
            h,
          ),
        ],
      ),
    ],
    h,
  )

const errorBanner = (draft: SettingsDraft, h: HtmlBuilder<Message>): Child =>
  Option.match(draft.weightsError, {
    onNone: () => h.empty,
    onSome: (error) =>
      h.div(
        [
          h.Class(
            'flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive',
          ),
        ],
        [icon(h, CircleAlert, 'size-4 shrink-0'), h.span([], [error])],
      ),
  })

const saveBar = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex gap-2')],
    [
      button<Message>(
        {
          onClick: Message.ClickedSaveSettings(),
          size: 'lg',
          className: 'h-11 flex-1 border-0 bg-[var(--theme-ink)] text-base font-bold text-white',
        },
        [icon(h, Save, 'size-4', 'inline-start'), 'Save settings'],
        h,
      ),
      button<Message>(
        {
          onClick: Message.ClickedResetSettings(),
          variant: 'outline',
          size: 'lg',
          className: 'h-11 border-0 bg-[var(--theme-block)] px-4 shadow-none',
          attributes: [h.AriaLabel('Reset changes')],
        },
        [icon(h, RotateCcw, 'size-4')],
        h,
      ),
    ],
  )

/**
 * Appearance: five Mochi swatches in one row. Each button is a plain square
 * of its own tint; the stored theme marks itself with a strong-tone ring.
 * Picking sends `PickedTheme`, which writes the DOM and storage at once —
 * no save gating.
 */
const appearanceSection = (h: HtmlBuilder<Message>): Html => {
  const current = readTheme()
  return section(
    'Appearance',
    'A pastel tint for the dashboard hero and today\u2019s activity bar. Applies at once.',
    [
      h.div(
        [h.Class('flex items-center gap-2.5')],
        themeKeys.map((key) => {
          const meta = themeMeta[key]
          const active = key === current
          return h.button(
            [
              h.OnClick(Message.PickedTheme({ theme: key })),
              h.Class(
                active
                  ? 'size-11 shrink-0 rounded-xl border-0 outline-none ring-2 ring-[var(--theme-strong)] ring-offset-2 ring-offset-white'
                  : 'size-11 shrink-0 rounded-xl border-0 outline-none',
              ),
              h.Style({ backgroundColor: meta.tint }),
              h.AriaPressed(active ? 'true' : 'false'),
              h.AriaLabel(`${meta.name} theme`),
            ],
            [],
          )
        }),
      ),
    ],
    h,
  )
}

export const settingsView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Child> => {
  const draft = model.settingsDraft
  return [
    errorBanner(draft, h),
    ...(draft.saved
      ? [
          h.div(
            [
              h.Class(
                'rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400',
              ),
            ],
            ['Settings saved on this device.'],
          ),
        ]
      : []),
    appearanceSection(h),
    fsrsSection(draft, h),
    defaultsSection(draft, h),
    behaviourSection(draft, h),
    saveBar(h),
    section(
      'Collection',
      'Your data, out. One JSON file with Decks, Notes, Cards, Schedules, and the Review log.',
      [
        h.div(
          [h.Class(fieldBlockClass)],
          [
            button<Message>(
              {
                onClick: Message.ClickedExport(),
                variant: 'outline',
                size: 'lg',
                className: 'h-11 w-full border-0 bg-white text-base shadow-none',
              },
              [icon(h, Download, 'size-4', 'inline-start'), 'Export collection as JSON'],
              h,
            ),
          ],
        ),
      ],
      h,
    ),
    h.div(
      [h.Class('px-1')],
      [
        separator<Message>({}, h),
        h.p(
          [h.Class('py-2 text-[11px] leading-relaxed text-[var(--theme-sub)]')],
          [
            'FSRS-6 with 21 weights. Saved settings apply to future Reviews only — existing Schedules keep their intervals.',
          ],
        ),
      ],
    ),
  ]
}
