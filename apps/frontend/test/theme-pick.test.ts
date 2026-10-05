/**
 * The Appearance pick: `PickedTheme` starts one `ApplyTheme` Command that
 * writes the DOM and storage, and `AppliedTheme` changes nothing. The Model
 * never holds the theme — it stays local-only — so these transitions assert
 * the Command the pick starts and that the Model is untouched.
 */

import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import type { Url } from 'foldkit/url'
import { Message, seedModel } from '../src/app/model'
import { update } from '../src/app/update'

const url = (pathname: string): Url => ({
  protocol: 'http:',
  host: 'localhost',
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
})

const names = (result: {
  readonly commands?: ReadonlyArray<{ readonly name: string }>
}): string[] => (result.commands ?? []).map((command) => command.name)

const themeArgs = (result: {
  readonly commands?: ReadonlyArray<{ readonly name: string; readonly args?: unknown }>
}): unknown => {
  const command = (result.commands ?? []).find((entry) => entry.name === 'ApplyTheme')
  if (command === undefined) throw new Error('expected an ApplyTheme command')
  return (command.args as { readonly theme?: unknown } | undefined)?.theme
}

describe('Appearance pick', () => {
  it('starts ApplyTheme with the picked swatch and keeps the model', () => {
    const before = seedModel(url('/settings'))
    const result = update(before, Message.PickedTheme({ theme: 'mochi-sage' }))
    expect(names(result)).toEqual(['ApplyTheme'])
    expect(themeArgs(result)).toBe('mochi-sage')
    expect(result.model).toEqual(before)
  })

  it('changes nothing when ApplyTheme answers', () => {
    const before = seedModel(url('/settings'))
    const result = update(before, Message.AppliedTheme())
    expect(result.commands ?? []).toEqual([])
    expect(result.model).toEqual(before)
  })
})
