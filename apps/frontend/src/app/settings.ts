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
 */

import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { CircleAlert, RotateCcw, Save } from 'lucide'
import { Card } from '@/components/ui/card'
import { input } from '@/components/ui/input'
import { nativeSelect, nativeSelectOption } from '@/components/ui/native-select'
import { separator } from '@/components/ui/separator'
import { switch_ } from '@/components/ui/switch'
import { textarea } from '@/components/ui/textarea'
import { button } from '@/components/ui/button'
import { icon } from '@/lib/icons'
import { Message } from './model'
import type { Model, SettingsDraft } from './model'

type Child = Html | string

const section = (
  title: string,
  description: string,
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<Message>,
): Html =>
  Card<Message>(
    {},
    [
      Card.header<Message>(
        {},
        [Card.title<Message>({}, [title], h), Card.description<Message>({}, [description], h)],
        h,
      ),
      Card.content<Message>({}, [h.div([h.Class('flex flex-col gap-4')], [...children])], h),
    ],
    h,
  )

const numberField = (
  id: string,
  labelText: string,
  value: number,
  toMessage: (value: string) => Message,
  description: string | undefined,
  step: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('grid grid-cols-[1fr_auto] items-center gap-3')],
    [
      h.div(
        [h.Class('flex min-w-0 flex-col gap-0.5')],
        [
          h.span([h.Class('text-sm font-medium leading-none')], [labelText]),
          ...(description === undefined
            ? []
            : [h.span([h.Class('text-xs text-muted-foreground')], [description])]),
        ],
      ),
      h.input([
        h.Id(id),
        h.Type('number'),
        h.Value(String(value)),
        h.OnInput(toMessage),
        h.Step(step),
        h.Class(
          'h-8 w-24 rounded-lg border border-input bg-transparent px-2.5 py-1 text-right text-sm tabular-nums outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
        ),
      ]),
    ],
  )

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
        h,
      ),
      textarea<Message>(
        {
          id: 'fsrs-weights',
          label: 'FSRS weights (advanced)',
          description: '17 comma-separated values for FSRS-6. Wrong count blocks save.',
          value: draft.weightsText,
          onInput: (value) => Message.EditedWeights({ value }),
          rows: 3,
          wrapperClass: 'gap-1.5',
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
        h,
      ),
      numberField(
        'reviews-per-day',
        'Reviews per day',
        draft.reviewsPerDay,
        (value) => Message.EditedReviewsPerDay({ value }),
        undefined,
        '1',
        h,
      ),
      numberField(
        'lapse-minutes',
        'Lapse minutes',
        draft.lapseMinutes,
        (value) => Message.EditedLapseMinutes({ value }),
        'Pause before a lapsed Card returns',
        '1',
        h,
      ),
    ],
    h,
  )

const rolloverOptions = [0, 1, 2, 3, 4, 5, 6, 21, 22, 23].map((hour) => `${hour}:00`)

const behaviourSection = (draft: SettingsDraft, h: HtmlBuilder<Message>): Html =>
  section(
    'Behaviour',
    'What review sessions feel like and when the day rolls over.',
    [
      switch_<Message>(
        {
          id: 'review-sounds',
          label: 'Review sounds',
          description: 'Play a sound when grading a Card',
          isChecked: draft.reviewSounds,
          onToggle: (isChecked) => Message.ToggledReviewSounds({ isChecked }),
        },
        h,
      ),
      switch_<Message>(
        {
          id: 'tap-to-reveal',
          label: 'Tap anywhere to reveal',
          description: 'Reveal the answer with a tap, not just the button',
          isChecked: draft.tapToReveal,
          onToggle: (isChecked) => Message.ToggledTapToReveal({ isChecked }),
        },
        h,
      ),
      switch_<Message>(
        {
          id: 'keep-awake',
          label: 'Keep screen awake',
          description: 'Prevent sleep during a review session',
          isChecked: draft.keepAwake,
          onToggle: (isChecked) => Message.ToggledKeepAwake({ isChecked }),
        },
        h,
      ),
      nativeSelect<Message>(
        {
          id: 'rollover-hour',
          label: 'Day rollover',
          description: 'When the next day’s Reviews become due',
          value: `${draft.dayRolloverHour}:00`,
          onChange: (value) => Message.EditedRolloverHour({ value: value.split(':')[0] ?? '4' }),
          options: rolloverOptions.map((option) =>
            nativeSelectOption<Message>({ value: option, label: option }, h),
          ),
        },
        h,
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

export const settingsView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Child> => {
  void input
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
    fsrsSection(draft, h),
    defaultsSection(draft, h),
    behaviourSection(draft, h),
    h.div(
      [h.Class('flex gap-2 pb-2')],
      [
        button<Message>(
          { onClick: Message.ClickedSaveSettings(), size: 'lg', className: 'flex-1' },
          [icon(h, Save, 'size-4', 'inline-start'), 'Save settings'],
          h,
        ),
        button<Message>(
          {
            onClick: Message.ClickedResetSettings(),
            variant: 'outline',
            size: 'lg',
            attributes: [h.AriaLabel('Reset changes')],
          },
          [icon(h, RotateCcw, 'size-4')],
          h,
        ),
      ],
    ),
    h.div(
      [h.Class('px-1')],
      [
        separator<Message>({}, h),
        h.p(
          [h.Class('py-2 text-[11px] leading-relaxed text-muted-foreground')],
          [
            'FSRS-6 with 17 weights. Saved settings apply to future Reviews only — existing Schedules keep their intervals.',
          ],
        ),
      ],
    ),
  ]
}
