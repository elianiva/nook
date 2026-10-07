import { Option } from 'effect'
import type { Url } from 'foldkit/url'

export const url = (pathname: string): Url => ({
  protocol: 'http:',
  host: 'localhost',
  port: Option.none(),
  pathname,
  search: Option.none(),
  hash: Option.none(),
})

export const names = (result: {
  readonly commands?: ReadonlyArray<{ readonly name: string }>
}): string[] => (result.commands ?? []).map((command) => command.name)

export const some = <A>(option: Option.Option<A>): A => {
  if (Option.isNone(option)) throw new Error('expected Some')
  return option.value
}
