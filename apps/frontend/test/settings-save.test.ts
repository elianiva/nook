import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import { DEFAULT_SETTINGS } from '@nook/api'
import { Message, seedModel } from '../src/app/model'
import { update } from '../src/app/update'
import { names, url } from './helpers'

describe('settings save', () => {
  it('applies optimistically, rolls back on failure, and retries the intact draft', () => {
    const edited = update(
      seedModel(url('/settings')),
      Message.EditedRetention({ value: '0.91' }),
    ).model
    const saving = update(edited, Message.ClickedSaveSettings())
    expect(saving.model.settings.fsrs.desiredRetention).toBe(0.91)
    expect(saving.model.settingsDraft.saving).toBe(true)
    expect(Option.isSome(saving.model.settingsRollback)).toBe(true)
    expect(names(saving)).toEqual(['SaveSettings'])

    const failed = update(
      saving.model,
      Message.LoadFailed({ error: 'offline', retry: 'saveSettings' }),
    )
    expect(failed.model.settings).toEqual(DEFAULT_SETTINGS)
    expect(failed.model.settingsDraft.desiredRetention).toBe(0.91)
    expect(failed.model.settingsDraft.saving).toBe(false)
    expect(Option.isSome(failed.model.notice)).toBe(true)

    const retried = update(failed.model, Message.ClickedRetry())
    expect(retried.model.settings.fsrs.desiredRetention).toBe(0.91)
    expect(retried.model.settingsDraft.saving).toBe(true)
    expect(names(retried)).toEqual(['SaveSettings'])
  })

  it('does not replace a newer edit when an in-flight save answers', () => {
    const edited = update(
      seedModel(url('/settings')),
      Message.EditedRetention({ value: '0.91' }),
    ).model
    const saving = update(edited, Message.ClickedSaveSettings()).model
    const newerDraft = update(saving, Message.EditedRetention({ value: '0.92' })).model
    const saved = update(
      newerDraft,
      Message.SavedSettings({
        ...DEFAULT_SETTINGS,
        fsrs: { ...DEFAULT_SETTINGS.fsrs, desiredRetention: 0.91 },
      }),
    )

    expect(saved.model.settings.fsrs.desiredRetention).toBe(0.91)
    expect(saved.model.settingsDraft.desiredRetention).toBe(0.92)
    expect(saved.model.settingsDraft.saved).toBe(false)
    expect(Option.isNone(saved.model.settingsRollback)).toBe(true)
  })
})
