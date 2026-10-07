/**
 * Page-slide view transition: the content column slides on a 220ms
 * ease-out-back curve while the header and tab bar swap instantly underneath.
 * (The pill glides on its own transform transition in the live DOM.)
 *
 * Foldkit wraps a render in `document.startViewTransition` when this
 * predicate returns `{ types }`. The direction comes from comparing the
 * previous and next routes' tab positions — no route history in the Model.
 * Only cross-tab moves slide; drill-ins and data refreshes render plainly.
 */

import { Runtime } from 'foldkit'
import type { Message, Model } from './model'
import type { AppRoute } from './routes'
import { NAV_TABS, routeToTab } from './routes'

export const transitionDirection = (
  previous: AppRoute,
  next: AppRoute,
): 'forward' | 'backward' | undefined => {
  const from = NAV_TABS.indexOf(routeToTab(previous))
  const to = NAV_TABS.indexOf(routeToTab(next))
  if (from === to) return undefined
  return to > from ? 'forward' : 'backward'
}

export const viewTransition: Runtime.ViewTransitionConfig<Model, Message> = ({
  previousModel,
  model,
}) => {
  const direction = transitionDirection(previousModel.route, model.route)
  if (direction === undefined) return false
  return { types: [direction === 'forward' ? 'slide-forward' : 'slide-backward'] }
}
