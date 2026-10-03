import { describe, expect, it } from '@effect/vitest'
import { BLANK_COMPONENT, deckComponents, joinComponents } from '../src/DeckName'

describe('deckComponents', () => {
  it('reads a Deck at the root', () => {
    expect(deckComponents('Japanese')).toEqual(['Japanese'])
  })

  it('reads a nested Deck, root first', () => {
    expect(deckComponents('Japanese\u001fVocab\u001fLesson 1')).toEqual([
      'Japanese',
      'Vocab',
      'Lesson 1',
    ])
  })

  it('substitutes blank for an empty component, as Anki does when it writes', () => {
    expect(deckComponents('Japanese\u001f\u001fVocab')).toEqual([
      'Japanese',
      BLANK_COMPONENT,
      'Vocab',
    ])
  })

  it('keeps a colon inside a component, which :: would have lost', () => {
    expect(deckComponents('Japanese\u001fGrammar: advanced')).toEqual([
      'Japanese',
      'Grammar: advanced',
    ])
  })

  it('reads a Deck that was never named as having no components', () => {
    expect(deckComponents('')).toEqual([])
  })
})

describe('joinComponents', () => {
  it('round-trips every component', () => {
    const components = ['Japanese', 'Grammar: advanced', 'Lesson 1']
    expect(deckComponents(joinComponents(components))).toEqual(components)
  })
})
