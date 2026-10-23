import { describe, expect, it } from 'vitest'
import { Message, seedModel } from '../src/app/model'
import {
  NAV_TABS,
  routeTitle,
  routeToTab,
  routeToUrl,
  tabToRoute,
  urlToAppRoute,
} from '../src/app/routes'
import { update } from '../src/app/update'
import { url } from './helpers'

describe('Stories route', () => {
  it('is directly addressable without becoming a bottom-navigation tab', () => {
    const route = urlToAppRoute(url('/stories'))
    expect(route).toEqual({ _tag: 'Stories' })
    expect(routeToUrl({ _tag: 'Stories' })).toBe('/stories')
    expect(routeTitle(route)).toBe('Stories')
    expect(routeToTab(route)).toBe('home')
    expect(NAV_TABS).toEqual(['home', 'decks', 'settings'])
    expect(tabToRoute('home')).toEqual({ _tag: 'Home' })
  })
})

describe('story feed controls', () => {
  it('refuses to generate without a word, and appends a batch when it arrives', () => {
    const initial = seedModel(url('/stories'))
    const refused = update(initial, Message.SubmittedStoryGeneration())
    expect(refused.commands ?? []).toHaveLength(0)
    expect(refused.model.storyFeed.generating).toBe(false)

    let model = update(initial, Message.EditedStoryWord({ value: '余韻' })).model
    const started = update(model, Message.SubmittedStoryGeneration())
    expect(started.model.storyFeed.generating).toBe(true)
    expect(started.commands).toHaveLength(1)
    // A second submit while one is in flight starts nothing.
    expect(update(started.model, Message.SubmittedStoryGeneration()).commands ?? []).toHaveLength(0)

    const before = initial.storyFeed.stories.length
    const story = { ...initial.storyFeed.stories[0]!, id: 'gen-1' }
    const done = update(started.model, Message.GotStories({ stories: [story] })).model
    expect(done.storyFeed.stories).toHaveLength(before + 1)
    expect(done.storyFeed.generating).toBe(false)
  })

  it('saves optimistically and lets the server answer settle the button', () => {
    const initial = seedModel(url('/stories'))
    const toggled = update(initial, Message.ToggledStorySave({ storyId: 'linger-2' }))
    expect(toggled.model.storyFeed.savedStoryIds).toEqual(['linger-2'])
    expect(toggled.commands).toHaveLength(1)

    // A failed save, or a removal refused because the Card has history, reverts the button.
    const failed = update(
      toggled.model,
      Message.SettledStorySave({ storyId: 'linger-2', saved: false }),
    ).model
    expect(failed.storyFeed.savedStoryIds).toEqual([])

    const kept = update(
      failed,
      Message.SettledStorySave({ storyId: 'linger-2', saved: true }),
    ).model
    expect(kept.storyFeed.savedStoryIds).toEqual(['linger-2'])
  })
})
