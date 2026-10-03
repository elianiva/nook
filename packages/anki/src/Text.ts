/**
 * The separators Anki writes inside `notes`.
 *
 * `notes.flds` joins a Note's Fields with a unit separator and escapes nothing,
 * so a Field that contains one corrupts the Note. `notes.tags` joins Tags with a
 * space, accepts an ideographic space as well, and wraps the run in one space at
 * each end.
 */

/** What Anki calls `UNIT_SEPARATOR`: the joiner between a Note's Fields. */
export const FIELD_SEPARATOR = '\x1f'

/** What Anki calls `is_tag_separator`: a space, or an ideographic space. */
const TAG_SEPARATOR = /[ 　]/

export const splitFields = (flds: string): ReadonlyArray<string> => flds.split(FIELD_SEPARATOR)

export const joinFields = (fields: ReadonlyArray<string>): string => fields.join(FIELD_SEPARATOR)

export const splitTags = (tags: string): ReadonlyArray<string> =>
  tags.split(TAG_SEPARATOR).filter((tag) => tag !== '')

export const joinTags = (tags: ReadonlyArray<string>): string =>
  tags.length === 0 ? '' : ` ${tags.join(' ')} `
