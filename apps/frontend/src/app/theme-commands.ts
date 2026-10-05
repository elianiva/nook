/**
 * The Appearance write: one DOM touch per pick.
 *
 * The theme is local-only — no server round trip — so `update` cannot apply
 * it directly (update stays pure, and the Model never holds the theme).
 * `ApplyTheme` runs after the click and sets `data-theme` on `<html>` plus
 * the `localStorage` record, then answers `AppliedTheme`, which changes
 * nothing and exists only so the Command answers with a result Message like
 * every other Command.
 */

import { Effect, Schema as S } from 'effect'
import { Command } from 'foldkit'
import { applyTheme, type ThemeKey } from '@/lib/theme'
import { Message as MessageConstructors } from './model'

export const ApplyTheme = Command.define('ApplyTheme', {
  args: { theme: S.String },
  messages: [MessageConstructors.AppliedTheme],
  execute: ({ theme }) =>
    Effect.sync(() => {
      applyTheme(theme as ThemeKey)
      return MessageConstructors.AppliedTheme()
    }),
})
