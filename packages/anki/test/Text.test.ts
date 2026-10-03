import { describe, expect, it } from '@effect/vitest'
import { joinFields, joinTags, splitFields, splitTags } from '../src/Text'

describe('splitFields', () => {
  it('keeps empty Fields, because their position carries meaning', () => {
    expect(splitFields('Front\u001f\u001fBack')).toEqual(['Front', '', 'Back'])
  })

  it('reads a Note with one Field', () => {
    expect(splitFields('Cloze')).toEqual(['Cloze'])
  })

  it('reads a Note with no Fields at all', () => {
    expect(splitFields('')).toEqual([''])
  })
})

describe('joinFields', () => {
  it('round-trips every Field that Anki can store', () => {
    const fields = ['Front', '', 'Back', 'a-nbsp', ' spaced ']
    expect(splitFields(joinFields(fields))).toEqual(fields)
  })

  it('cannot round-trip a Field that holds the separator, which is why Anki corrupts it', () => {
    expect(splitFields(joinFields(['Back\u001finside']))).toEqual(['Back', 'inside'])
  })
})

describe('splitTags', () => {
  it('drops the padding Anki writes at both ends', () => {
    expect(splitTags(' noun verb ')).toEqual(['noun', 'verb'])
  })

  it('treats an ideographic space as a separator too', () => {
    expect(splitTags('　noun　verb　')).toEqual(['noun', 'verb'])
  })

  it('reads a Note with no Tags', () => {
    expect(splitTags('')).toEqual([])
  })
})

describe('joinTags', () => {
  it('wraps the run in one space at each end, as Anki does', () => {
    expect(joinTags(['noun', 'verb'])).toBe(' noun verb ')
  })

  it('writes an empty string for no Tags, not a padded one', () => {
    expect(joinTags([])).toBe('')
  })

  it('round-trips every Tag', () => {
    const tags = ['marked', 'leech', 'to-rome']
    expect(splitTags(joinTags(tags))).toEqual(tags)
  })
})
