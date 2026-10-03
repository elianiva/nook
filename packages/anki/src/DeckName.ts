/**
 * How Anki stores a Deck's name.
 *
 * `decks.name` holds the native name, which is the name's components joined
 * with a unit separator. Anki shows the human name instead, the same components
 * joined with `::`. nook keeps the components, because `::` is lossy: a component
 * may itself contain a colon.
 *
 * Anki replaces an empty component with the word `blank` when it writes a name,
 * so `foo::::baz` is stored as `foo`, `blank`, `baz`. Reading applies the same
 * rule, which covers a name written before Anki normalized it.
 */

/** What Anki stores in place of an empty component. */
export const BLANK_COMPONENT = 'blank'

const COMPONENT_SEPARATOR = '\x1f'

/**
 * The components of a Deck, from the root down. An empty native name carries no
 * components, which is what a Deck row that was never named holds.
 */
export const deckComponents = (name: string): ReadonlyArray<string> => {
  if (name === '') {
    return []
  }
  return name
    .split(COMPONENT_SEPARATOR)
    .map((component) => (component === '' ? BLANK_COMPONENT : component))
}

/**
 * The native name for a list of components. nook never writes a Deck back to
 * Anki, so this exists because the schema needs an encode direction and the
 * tests need the round trip.
 */
export const joinComponents = (components: ReadonlyArray<string>): string =>
  components.join(COMPONENT_SEPARATOR)
