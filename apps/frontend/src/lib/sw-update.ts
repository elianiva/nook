/**
 * Taking a waiting service worker. The worker never skips waiting on its own
 * (see `src/sw.ts`); the learner's reload is the only thing that activates a
 * newer shell. A plain `location.reload()` is not enough: the old page is
 * still a client of the old worker while the new one loads, so the update
 * would stay waiting. Messaging the waiting worker makes it take over, and
 * the page reloads once it controls this page.
 */

export const SKIP_WAITING = 'nook:skip-waiting'

/** The slice of `ServiceWorkerContainer` this module touches, so tests can fake it. */
export interface WorkerContainer {
  readonly getRegistration: () => Promise<
    { readonly waiting: { postMessage: (message: unknown) => void } | null } | undefined
  >
  readonly addEventListener: (type: 'controllerchange', listener: () => void) => void
}

/**
 * Activates the waiting worker and calls `reload` when it takes control. With
 * nothing waiting it reloads straight away, so the button never does nothing.
 */
export const applyWaitingWorker = async (
  container: WorkerContainer,
  reload: () => void,
): Promise<void> => {
  const registration = await container.getRegistration().catch(() => undefined)
  const waiting = registration?.waiting ?? null
  if (waiting === null) {
    reload()
    return
  }
  container.addEventListener('controllerchange', reload)
  waiting.postMessage({ type: SKIP_WAITING })
}
