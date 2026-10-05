import { describe, expect, it } from '@effect/vitest'
import { Arbitrary } from 'effect'
import { BLANK_COMPONENT, deckComponents, joinComponents } from '../src/DeckName'
import { text } from './Generators'

/** An empty component is stored as `blank`, so a round trip cannot carry one. */
const component = text.pipe(
  Arbitrary.filter((value) => value.length > 0 && !value.includes('\x1f')),
)

/** A native name with no empty component, which is the only kind that round-trips. */
const name = text.pipe(
  Arbitrary.filter(
    (value) => !value.startsWith('\x1f') && !value.endsWith('\x1f') && !value.includes('\x1f\x1f'),
  ),
)

describe('deckComponents and joinComponents', () => {
  it.prop(
    'round-trips every component, including a colon inside one',
    [Arbitrary.array(component)],
    ([components]) => {
      expect(deckComponents(joinComponents(components))).toEqual(components)
    },
  )

  it.prop('round-trips every native name Anki can store', [name], ([native]) => {
    expect(joinComponents(deckComponents(native))).toBe(native)
  })

  it('substitutes blank for an empty component, as Anki does when it writes', () => {
    expect(deckComponents('Japanese\x1f\x1fVocab')).toEqual(['Japanese', BLANK_COMPONENT, 'Vocab'])
  })
})
