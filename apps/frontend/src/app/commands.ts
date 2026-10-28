/**
 * Commands: one request each, whose answer comes back as a Message.
 *
 * Navigation lives here; fetch/save Commands live in `api-commands`. Every
 * Command answers with a result Message, failure included, rather than a
 * thrown error.
 */

import { Effect, Schema as S } from 'effect'
import { Command, Dom, Navigation, Url } from 'foldkit'
import { Message } from './model'

export const NavigateInternal = Command.define('NavigateInternal', {
  args: { url: Url.Url },
  messages: [Message.CompletedNavigate],
  execute: ({ url }) =>
    Navigation.pushUrl(Url.toString(url)).pipe(Effect.as(Message.CompletedNavigate())),
})

/** Opens the standalone account page, which the gate renders instead of the app. */
export const LoadAccountPage = Command.define('LoadAccountPage', {
  args: { path: S.String },
  messages: [Message.CompletedNavigate],
  execute: ({ path }) => Navigation.load(path).pipe(Effect.as(Message.CompletedNavigate())),
})

/** Navigates to a path the app built itself, such as a Start action's review URL. */
export const NavigateToPath = Command.define('NavigateToPath', {
  args: { path: S.String },
  messages: [Message.CompletedNavigate],
  execute: ({ path }) => Navigation.pushUrl(path).pipe(Effect.as(Message.CompletedNavigate())),
})

/**
 * Moves keyboard and screen-reader focus to the element `selector` names once
 * the next render commits. A missing element is not an error: the screen that
 * would have owned the focus simply is not showing.
 */
export const FocusElement = Command.define('FocusElement', {
  args: { selector: S.String },
  messages: [Message.CompletedFocus],
  execute: ({ selector }) =>
    Dom.focus(selector, { makeFocusable: true, preventScroll: true }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedFocus()),
    ),
})
