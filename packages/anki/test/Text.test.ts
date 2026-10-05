import { describe, expect, it } from '@effect/vitest'
import { Arbitrary, Schema } from 'effect'
import { FIELD_SEPARATOR, joinFields, joinTags, splitFields, splitTags } from '../src/Text'
import { nonEmptyText, text } from './Generators'

/** A Field Anki can store: the separator would end it early, so it holds none. */
const field = text.pipe(Arbitrary.filter((value) => !value.includes(FIELD_SEPARATOR)))

/** A Tag Anki can store: non-empty, and free of both separators. */
const tag = nonEmptyText.pipe(Arbitrary.filter((value) => !/[ 　]/.test(value)))

describe('splitFields and joinFields', () => {
  it.prop(
    'round-trips every Field Anki can store',
    [Arbitrary.array(field, { minLength: 1 })],
    ([fields]) => {
      expect(splitFields(joinFields(fields))).toEqual(fields)
    },
  )

  it.prop('returns the joined text unchanged', [Arbitrary.schema(Schema.String)], ([joined]) => {
    expect(joinFields(splitFields(joined))).toBe(joined)
  })

  it('keeps empty Fields, because their position carries meaning', () => {
    expect(splitFields('Front\x1f\x1fBack')).toEqual(['Front', '', 'Back'])
  })

  it('cannot round-trip a Field that holds the separator, which is why Anki corrupts it', () => {
    expect(splitFields(joinFields(['Back\x1finside']))).toEqual(['Back', 'inside'])
  })
})

describe('splitTags and joinTags', () => {
  it.prop('round-trips every Tag Anki can store', [Arbitrary.array(tag)], ([tags]) => {
    expect(splitTags(joinTags(tags))).toEqual(tags)
  })

  it('wraps the run in one space at each end, as Anki does', () => {
    expect(joinTags(['noun', 'verb'])).toBe(' noun verb ')
  })

  it('writes an empty string for no Tags, not a padded one', () => {
    expect(joinTags([])).toBe('')
  })

  it('drops the padding Anki writes, including an ideographic space', () => {
    expect(splitTags(' noun　verb ')).toEqual(['noun', 'verb'])
  })
})
