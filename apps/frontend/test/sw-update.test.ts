/**
 * The reload prompt: a waiting worker is activated by message, then the page
 * reloads once it controls it; the shell shows the prompt only outside review.
 */

import { describe, expect, it } from 'vitest'
import { getAllByText, getByText, given, scene, tap } from 'foldkit/scene'
import { Message, seedModel } from '../src/app/model'
import { update } from '../src/app/update'
import { names, url } from './helpers'
import { shell } from '../src/app/shell'
import type { HtmlBuilder } from 'foldkit/html'
import type { Model } from '../src/app/model'
import { applyWaitingWorker, SKIP_WAITING } from '../src/lib/sw-update'
import type { WorkerContainer } from '../src/lib/sw-update'

const fakeContainer = (waiting: boolean) => {
  const posted: unknown[] = []
  const listeners: Array<() => void> = []
  const container: WorkerContainer = {
    getRegistration: async () => ({
      waiting: waiting ? { postMessage: (message) => void posted.push(message) } : null,
    }),
    addEventListener: (_type, listener) => void listeners.push(listener),
  }
  return { container, posted, listeners }
}

describe('applyWaitingWorker', () => {
  it('messages the waiting worker and reloads only after it takes control', async () => {
    const { container, posted, listeners } = fakeContainer(true)
    let reloads = 0
    await applyWaitingWorker(container, () => void reloads++)
    expect(posted).toEqual([{ type: SKIP_WAITING }])
    expect(reloads).toBe(0)
    listeners.forEach((listener) => listener())
    expect(reloads).toBe(1)
  })

  it('reloads straight away when nothing is waiting', async () => {
    const { container, posted } = fakeContainer(false)
    let reloads = 0
    await applyWaitingWorker(container, () => void reloads++)
    expect(posted).toEqual([])
    expect(reloads).toBe(1)
  })
})

describe('update prompt', () => {
  const view = (model: Model, h: HtmlBuilder<Message>) => shell(model, [], h)
  const ready = (path: string): Model =>
    update(seedModel(url(path)), Message.ServiceWorkerAvailable()).model

  it('shows a Reload prompt outside review once an update is waiting', () => {
    scene(
      { update, view },
      given(ready('/decks')),
      tap((simulation) => {
        expect(getByText('A newer version is ready.')(simulation.html)).toBeDefined()
      }),
    )
  })

  it('stays hidden mid-review', () => {
    for (const path of ['/review', '/review/n5']) {
      const model = ready(path)
      expect(model.route._tag).toMatch(/^Review/)
      scene(
        { update, view },
        given(model),
        tap((simulation) => {
          expect(getAllByText('A newer version is ready.')(simulation.html)).toEqual([])
        }),
      )
    }
  })

  it('starts ReloadApp when the learner clicks Reload', () => {
    expect(names(update(ready('/decks'), Message.ClickedReloadApp()))).toEqual(['ReloadApp'])
  })
})
