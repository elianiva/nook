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
 * Mobile layout: each section is one grouped card; every row inside is a
 * side-by-side label-left/control-right pair. Controls keep a fixed narrow
 * width (number inputs `w-24`, select `w-28`) so the label keeps most of the
 * ~340px card content width on a 390px phone. Chrome on Android zooms the
 * page when a sub-16px input takes focus, which breaks the narrow shell
 * frame — every text control here sets 16px text so focus never zooms. Only
 * the weights textarea spans full width, stacked under its label.
 */

import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { CircleAlert, Download, RotateCcw, Save } from 'lucide'
import { nativeSelect, nativeSelectOption } from '@/components/ui/native-select'
import { switch_ } from '@/components/ui/switch'
import { textarea } from '@/components/ui/textarea'
import { button } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import { themeKeys, themeMeta } from '@/lib/theme'
import { Message } from './model'
import type { HintSlot, Model, SettingsDraft } from './model'
import { hint } from './hints'

type Child = Html | string

const section = (title: string, rows: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.span(
        [h.Class('text-[11px] font-bold tracking-[2.2px] text-[var(--theme-sub)] uppercase')],
        [title],
      ),
      groupCard(rows, h),
    ],
  )

/**
 * One settings section is one grouped `--theme-block` card; every row inside
 * is a side-by-side label-left/control-right pair, so each field costs one
 * line instead of two. Rows divide with a hairline; only the weights
 * textarea stacks full width under its label.
 */
const groupCard = (children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        'flex flex-col divide-y divide-black/5 rounded-[14px] border-0 bg-[var(--theme-block)] px-3.5',
      ),
    ],
    [...children],
  )

/** One side-by-side row: the label keeps the width, the control hugs the right. */
const rowClass = 'flex items-center gap-3 py-2.5'

const rowLabel = (
  id: string,
  labelText: string,
  h: HtmlBuilder<Message>,
  hinted?: Readonly<{ slot: HintSlot; text: string; model: Model }>,
): Html =>
  h.label(
    [h.For(id), h.Class('min-w-0 flex-1 text-[13px] font-semibold leading-snug')],
    [
      labelText,
      ...(hinted === undefined ? [] : [' ', hint(hinted.slot, hinted.text, hinted.model, h)]),
    ],
  )

/** White control inside a row: no outline, ink text, 16px text. */
const fieldControlClass =
  'rounded-[10px] border-0 bg-white font-semibold text-[var(--theme-ink)] shadow-none tabular-nums outline-none'

/**
 * Shared number-input classes: the box hugs the value, with the same padding
 * on both sides and centred text, so the digit block sits centred. 16px text
 * keeps mobile focus from zooming.
 */
const numberInputClass =
  'h-9 w-20 shrink-0 px-3 py-1.5 text-center text-base transition-colors placeholder:text-[var(--theme-sub)] ' +
  fieldControlClass

const numberField = (
  id: string,
  labelText: string,
  value: number,
  toMessage: (value: string) => Message,
  step: string,
  extra: Readonly<{
    min?: string
    max?: string
    inputMode?: string
  }>,
  h: HtmlBuilder<Message>,
  hinted?: Readonly<{ slot: HintSlot; text: string; model: Model }>,
): Html =>
  h.div(
    [h.Class(rowClass)],
    [
      rowLabel(id, labelText, h, hinted),
      h.input([
        h.Id(id),
        h.Type('number'),
        h.Value(String(value)),
        h.OnInput(toMessage),
        h.Step(step),
        ...(extra.min === undefined ? [] : [h.Min(extra.min)]),
        ...(extra.max === undefined ? [] : [h.Max(extra.max)]),
        ...(extra.inputMode === undefined ? [] : [h.InputMode(extra.inputMode)]),
        h.Class(numberInputClass),
      ]),
    ],
  )

const weightsRow = (draft: SettingsDraft, model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col gap-2 py-2.5')],
    [
      rowLabel('fsrs-weights', 'FSRS weights (advanced)', h, {
        slot: 'fsrs-weights',
        text: '21 comma-separated values for FSRS-6. Wrong count blocks save.',
        model,
      }),
      textarea<Message>(
        {
          id: 'fsrs-weights',
          label: 'FSRS weights (advanced)',
          value: draft.weightsText,
          onInput: (value) => Message.EditedWeights({ value }),
          rows: 2,
          wrapperClass: 'gap-0',
          labelClass: 'sr-only',
          className: 'border-0 bg-white font-mono shadow-none outline-none',
        },
        h,
      ),
    ],
  )

const fsrsSection = (draft: SettingsDraft, model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    'FSRS scheduling',
    [
      numberField(
        'desired-retention',
        'Desired retention',
        draft.desiredRetention,
        (value) => Message.EditedRetention({ value }),
        '0.01',
        { min: '0.7', max: '0.95', inputMode: 'decimal' },
        h,
        { slot: 'desired-retention', text: 'Target recall rate, 0.70–0.95.', model },
      ),
      weightsRow(draft, model, h),
      numberField(
        'maximum-interval',
        'Maximum interval',
        draft.maximumInterval,
        (value) => Message.EditedMaximumInterval({ value }),
        '1',
        { min: '1', inputMode: 'numeric' },
        h,
        { slot: 'maximum-interval', text: 'Cap on any interval, in days.', model },
      ),
    ],
    h,
  )

const defaultsSection = (draft: SettingsDraft, model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    'Deck defaults',
    [
      numberField(
        'new-per-day',
        'New Cards per day',
        draft.newPerDay,
        (value) => Message.EditedNewPerDay({ value }),
        '1',
        { min: '0', inputMode: 'numeric' },
        h,
      ),
      numberField(
        'reviews-per-day',
        'Reviews per day',
        draft.reviewsPerDay,
        (value) => Message.EditedReviewsPerDay({ value }),
        '1',
        { min: '0', inputMode: 'numeric' },
        h,
      ),
      numberField(
        'lapse-minutes',
        'Lapse minutes',
        draft.lapseMinutes,
        (value) => Message.EditedLapseMinutes({ value }),
        '1',
        { min: '1', inputMode: 'numeric' },
        h,
      ),
    ],
    h,
  )

const rolloverOptions = Array.from({ length: 24 }, (_, hour) => `${hour}:00`)

const behaviourSection = (draft: SettingsDraft, model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    'Behaviour',
    [
      h.div(
        [h.Class('py-2.5')],
        [
          switch_<Message>(
            {
              id: 'tap-to-reveal',
              label: 'Tap anywhere to reveal',
              isChecked: draft.tapToReveal,
              onToggle: (isChecked) => Message.ToggledTapToReveal({ isChecked }),
              className: 'shrink-0 border-0 data-checked:bg-[var(--theme-tint)]',
              labelClass: 'flex-1 text-[13px] font-semibold',
              wrapperClass: 'w-full flex-row-reverse justify-between gap-3',
            },
            h,
          ),
        ],
      ),
      h.div(
        [h.Class(rowClass)],
        [
          rowLabel('rollover-hour', 'Day rollover', h),
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
              wrapperClass: 'w-auto shrink-0',
              className:
                'h-9 w-28 border-0 bg-white text-right font-semibold shadow-none outline-none',
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
 * of its own tint; the picked theme marks itself with a strong-tone ring.
 * Picking sends `PickedTheme`, which writes the DOM and storage at once and
 * mirrors the pick into the Model — no save gating, and the ring moves on
 * the same render.
 */
const appearanceSection = (model: Model, h: HtmlBuilder<Message>): Html => {
  const current = model.theme
  return section(
    'Appearance',
    [
      h.div(
        [h.Class('flex items-center gap-2 py-2.5')],
        themeKeys.map((key) => {
          const meta = themeMeta[key]
          const active = key === current
          return h.button(
            [
              h.OnClick(Message.PickedTheme({ theme: key })),
              h.Class(
                active
                  ? 'size-9 shrink-0 rounded-xl border-0 outline-none ring-2 ring-[var(--theme-strong)] ring-offset-2 ring-offset-white'
                  : 'size-9 shrink-0 rounded-xl border-0 outline-none',
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
    appearanceSection(model, h),
    fsrsSection(draft, model, h),
    defaultsSection(draft, model, h),
    behaviourSection(draft, model, h),
    saveBar(h),
    section(
      'Collection',
      [
        h.div(
          [h.Class('py-2.5')],
          [
            button<Message>(
              {
                onClick: Message.ClickedExport(),
                variant: 'outline',
                size: 'lg',
                className: 'h-9 w-full border-0 bg-white text-sm shadow-none',
              },
              [icon(h, Download, 'size-4', 'inline-start'), 'Export collection as JSON'],
              h,
            ),
          ],
        ),
      ],
      h,
    ),
  ]
}
