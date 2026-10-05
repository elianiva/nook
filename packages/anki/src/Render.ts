/**
 * `@nook/anki/render` — turn a Note into a Card's two sides.
 *
 * Anki renders a Card from three things: the Note's Fields, one Template's
 * `q_format` and `a_format`, and the Note Type's stylesheet. This module
 * reproduces the subset of Anki's template language that real decks use:
 *
 * - `{{Field}}` substitutes a Field; `{{text:Field}}` strips its HTML first.
 * - `{{FrontSide}}` is the question side, which is how an answer side repeats
 *   the prompt above the divider.
 * - `{{#Field}}…{{/Field}}` renders when the Field is non-empty, and
 *   `{{^Field}}…{{/Field}}` when it is empty.
 * - `{{cloze:Field}}` reveals the cloze deletions for the Card's ordinal.
 * - The special Fields `Tags`, `Deck`, `Subdeck`, `Card`, and `Type` come from
 *   the Card rather than the Note.
 * - `[sound:file.mp3]` becomes an `<audio>` element and relative `src`/`data`
 *   URLs are rewritten through `mediaUrl`.
 *
 * Two things Anki does that this module does not: it never runs LaTeX or TTS
 * tags, and it renders cloze ordinals without Anki's nesting edge cases. Both
 * are rare in the decks nook targets, and both fail visibly rather than
 * silently.
 *
 * The module is pure and browser-safe, so the Worker renders a queue with it
 * and a test can pin its behaviour without a database.
 */

/** One Field of a Note Type. Only `name` and `ord` are read here. */
export interface RenderField {
  readonly name: string
  readonly ord: number
}

/** One Template of a Note Type. Each Template produces one Card. */
export interface RenderTemplate {
  readonly name: string
  readonly ord: number
  readonly questionFormat: string
  readonly answerFormat: string
}

/** A Note Type, as nook stores it. */
export interface RenderNoteType {
  readonly name: string
  readonly kind: 'normal' | 'cloze'
  readonly css: string
  readonly fields: ReadonlyArray<RenderField>
  readonly templates: ReadonlyArray<RenderTemplate>
}

/** A Note, as nook stores it: Fields indexed by `ord`, Tags split out. */
export interface RenderNote {
  readonly fields: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
}

/** Everything one render needs. `mediaUrl` maps a Media file name to a URL. */
export interface RenderInput {
  readonly noteType: RenderNoteType
  readonly note: RenderNote
  readonly templateOrd: number
  readonly deckName: string
  readonly mediaUrl?: (name: string) => string
}

/** The two sides of a Card, plus the stylesheet they share. */
export interface RenderedCard {
  readonly question: string
  readonly answer: string
  readonly css: string
}

type Node =
  | { readonly kind: 'Text'; readonly text: string }
  | { readonly kind: 'Replacement'; readonly key: string; readonly filters: ReadonlyArray<string> }
  | {
      readonly kind: 'Conditional'
      readonly key: string
      readonly negated: boolean
      readonly children: ReadonlyArray<Node>
    }

/** Anki's cloze hint when the cloze carries none. */
const DEFAULT_CLOZE_HINT = '...'

/**
 * Parses a template into nodes.
 *
 * Anki splits a handlebar on `:` and reads the last segment as the key, so
 * `cloze:Text` means the `cloze` filter over the `Text` Field. The filters
 * before the key apply left to right.
 */
const parseTemplate = (format: string): ReadonlyArray<Node> => {
  const top: Array<Node> = []
  const stack: Array<{ key: string; negated: boolean; children: Array<Node> }> = []
  const current = (): Array<Node> => stack.at(-1)?.children ?? top
  let index = 0

  while (index < format.length) {
    const open = format.indexOf('{{', index)
    if (open === -1) {
      current().push({ kind: 'Text', text: format.slice(index) })
      break
    }
    if (open > index) current().push({ kind: 'Text', text: format.slice(index, open) })

    const close = format.indexOf('}}', open + 2)
    if (close === -1) {
      current().push({ kind: 'Text', text: format.slice(open) })
      break
    }

    const inner = format.slice(open + 2, close)
    index = close + 2

    if (inner.startsWith('#')) {
      stack.push({ key: inner.slice(1), negated: false, children: [] })
    } else if (inner.startsWith('^')) {
      stack.push({ key: inner.slice(1), negated: true, children: [] })
    } else if (inner.startsWith('/')) {
      const frame = stack.pop()
      if (frame !== undefined) {
        current().push({
          kind: 'Conditional',
          key: frame.key,
          negated: frame.negated,
          children: frame.children,
        })
      }
    } else {
      const parts = inner.split(':')
      const key = parts.pop() ?? ''
      current().push({ kind: 'Replacement', key, filters: parts })
    }
  }

  // An unbalanced open is a broken template. Close it rather than drop it, so
  // its content still renders.
  while (stack.length > 1) {
    const frame = stack.pop()
    if (frame === undefined) break
    current().push({
      kind: 'Conditional',
      key: frame.key,
      negated: frame.negated,
      children: frame.children,
    })
  }
  const last = stack.pop()
  if (last !== undefined) {
    top.push({ kind: 'Conditional', key: last.key, negated: last.negated, children: last.children })
  }

  return top
}

/** Removes tags and decodes the entities Anki's `text:` filter decodes. */
const stripHtml = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

/** Turns `漢字[かんじ]` into ruby markup, the shape Anki's `furigana:` filter produces. */
const applyFurigana = (text: string): string =>
  text.replace(/([^\s[\]]+)\[([^\]]+)\]/g, '<ruby>$1<rt>$2</rt></ruby>')

/** Whether a Field counts as empty for a conditional: whitespace and empty breaks do not count. */
const isEmptyField = (value: string): boolean =>
  value
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<\/?div[^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .trim().length === 0

/** Finds the `}}` that closes the cloze opened just before `from`, honouring nesting. */
const findClozeEnd = (text: string, from: number): number => {
  let depth = 1
  let index = from
  while (index < text.length) {
    if (text.startsWith('{{c', index)) {
      depth += 1
      index += 3
      continue
    }
    if (text.startsWith('}}', index)) {
      depth -= 1
      if (depth === 0) return index
      index += 2
      continue
    }
    index += 1
  }
  return -1
}

/** Splits a cloze body into its content and its hint, at the first top-level `::`. */
const splitClozeHint = (body: string): { content: string; hint: string | undefined } => {
  let depth = 0
  let index = 0
  while (index < body.length) {
    if (body.startsWith('{{c', index)) {
      depth += 1
      index += 3
      continue
    }
    if (body.startsWith('}}', index)) {
      depth -= 1
      index += 2
      continue
    }
    if (depth === 0 && body.startsWith('::', index)) {
      return { content: body.slice(0, index), hint: body.slice(index + 2) }
    }
    index += 1
  }
  return { content: body, hint: undefined }
}

/**
 * Reveals the cloze deletions in `text` for `ordinal`.
 *
 * On the question side the target cloze becomes `[hint]` and every other cloze
 * shows its text. On the answer side the target cloze shows its text. When the
 * text carries no cloze for `ordinal`, the result is empty, which is Anki's
 * behaviour and what keeps a mismatched Card from leaking the answer.
 */
const revealCloze = (text: string, ordinal: number, question: boolean): string => {
  let out = ''
  let index = 0
  let found = false
  let sawCloze = false

  while (index < text.length) {
    const open = text.indexOf('{{c', index)
    if (open === -1) {
      out += text.slice(index)
      break
    }
    const match = /^\{\{c(\d+(?:,\d+)*)::/.exec(text.slice(open))
    if (match === null) {
      out += text.slice(index, open + 3)
      index = open + 3
      continue
    }
    sawCloze = true
    out += text.slice(index, open)
    const bodyStart = open + match[0].length
    const end = findClozeEnd(text, bodyStart)
    if (end === -1) {
      out += text.slice(open)
      break
    }

    const { content, hint } = splitClozeHint(text.slice(bodyStart, end))
    const ordinals = (match[1] ?? '').split(',').map(Number)
    const active = ordinals.includes(ordinal)
    if (active) found = true

    if (active && question) {
      out += `<span class="cloze">[${hint ?? DEFAULT_CLOZE_HINT}]</span>`
    } else {
      const inner = revealCloze(content, ordinal, question)
      out += active
        ? `<span class="cloze">${inner}</span>`
        : `<span class="cloze-inactive">${inner}</span>`
    }
    index = end + 2
  }

  return sawCloze && !found ? '' : out
}

/** Applies one template filter. Unknown filters pass their input through. */
const applyFilter = (filter: string, text: string, ordinal: number, question: boolean): string => {
  switch (filter) {
    case 'text':
      return stripHtml(text)
    case 'cloze':
      return revealCloze(text, ordinal, question)
    case 'furigana':
    case 'kana':
    case 'kanji':
      return applyFurigana(text)
    default:
      // `type:`, `hint:`, `tts`, and anything unknown: show the Field as it is.
      return text
  }
}

interface SideContext {
  readonly fields: ReadonlyMap<string, string>
  readonly frontside: string | null
  readonly question: boolean
  readonly ordinal: number
}

const renderNodes = (nodes: ReadonlyArray<Node>, context: SideContext): string =>
  nodes.map((node) => renderNode(node, context)).join('')

const renderNode = (node: Node, context: SideContext): string => {
  switch (node.kind) {
    case 'Text':
      return node.text
    case 'Conditional': {
      const value = context.fields.get(node.key)
      const present =
        node.key === `c${context.ordinal}` ? true : value !== undefined && !isEmptyField(value)
      return present !== node.negated ? renderNodes(node.children, context) : ''
    }
    case 'Replacement': {
      if (node.key === 'FrontSide') return context.frontside ?? ''
      const raw = context.fields.get(node.key) ?? ''
      return node.filters.reduce(
        (text, filter) => applyFilter(filter, text, context.ordinal, context.question),
        raw,
      )
    }
  }
}

/** Rewrites `[sound:]` tags and relative media URLs so a browser can load them. */
const rewriteMedia = (html: string, mediaUrl: (name: string) => string): string => {
  const withSound = html.replace(
    /\[sound:([^\]]+)\]/g,
    (_match, name: string) => `<audio controls preload="none" src="${mediaUrl(name)}"></audio>`,
  )
  return withSound.replace(
    /(src|data)\s*=\s*("([^"]*)"|'([^']*)')/g,
    (
      match,
      attribute: string,
      _quotes: string,
      double: string | undefined,
      single: string | undefined,
    ) => {
      const value = double ?? single ?? ''
      if (value === '' || /^(?:https?:|data:|blob:|\/|#)/i.test(value)) return match
      return `${attribute}="${mediaUrl(value)}"`
    },
  )
}

/** Builds the Field map, then adds the special Fields Anki injects. */
const buildFields = (input: RenderInput): Map<string, string> => {
  const fields = new Map<string, string>()
  for (const field of input.noteType.fields) {
    fields.set(field.name, input.note.fields[field.ord] ?? '')
  }

  const template =
    input.noteType.templates.find((candidate) => candidate.ord === input.templateOrd) ??
    input.noteType.templates[0]

  // `or_insert` semantics: a real Field of the same name wins.
  const specials: ReadonlyArray<readonly [string, string]> = [
    ['Tags', input.note.tags.join(' ')],
    ['Deck', input.deckName],
    ['Subdeck', input.deckName.split('::').at(-1) ?? input.deckName],
    ['Card', template?.name ?? ''],
    ['Type', input.noteType.name],
  ]
  for (const [key, value] of specials) {
    if (!fields.has(key)) fields.set(key, value)
  }

  // `{{#c1}}` is true on the Card whose ordinal is 1.
  const ordinalKey = `c${input.templateOrd + 1}`
  if (input.noteType.kind === 'cloze' && !fields.has(ordinalKey)) fields.set(ordinalKey, '1')

  return fields
}

/**
 * Renders one Card from a Note.
 *
 * `templateOrd` names the Template; a Note Type with two Templates gives every
 * Note two Cards. An unknown ordinal falls back to the first Template rather
 * than rendering nothing.
 */
export const renderCard = (input: RenderInput): RenderedCard => {
  const fields = buildFields(input)
  const template =
    input.noteType.templates.find((candidate) => candidate.ord === input.templateOrd) ??
    input.noteType.templates[0]
  const ordinal = input.templateOrd + 1
  const mediaUrl = input.mediaUrl ?? ((name: string) => name)

  const question = renderNodes(parseTemplate(template?.questionFormat ?? ''), {
    fields,
    frontside: null,
    question: true,
    ordinal,
  })
  const answer = renderNodes(parseTemplate(template?.answerFormat ?? ''), {
    fields,
    frontside: question,
    question: false,
    ordinal,
  })

  return {
    question: rewriteMedia(question, mediaUrl),
    answer: rewriteMedia(answer, mediaUrl),
    css: input.noteType.css,
  }
}

/** Finds the `}` that closes the `{` at `open`, honouring nested braces. */
const findMatchingBrace = (css: string, open: number): number => {
  let depth = 0
  let index = open
  while (index < css.length) {
    const char = css[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
    index += 1
  }
  return -1
}

/** At-rules whose body is a rule list and must be scoped recursively. */
const CONDITIONAL_AT_RULES = ['@media', '@supports', '@container', '@layer', '@document', '@scope']

/** Prefixes every selector in `css` so a Note Type's stylesheet cannot leak into the app. */
const scopeRules = (css: string, scope: string): string => {
  const rules: Array<string> = []
  let index = 0

  while (index < css.length) {
    const open = css.indexOf('{', index)
    if (open === -1) break
    const close = findMatchingBrace(css, open)
    if (close === -1) break

    const selector = css.slice(index, open).trim()
    const body = css.slice(open + 1, close)
    index = close + 1
    if (selector === '') continue

    if (selector.startsWith('@')) {
      const conditional = CONDITIONAL_AT_RULES.some((rule) => selector.startsWith(rule))
      rules.push(
        conditional
          ? `${selector} {\n${scopeRules(body, scope)}\n}`
          : `${selector} { ${body.trim()} }`,
      )
    } else {
      const scoped = selector
        .split(',')
        .map((part) => {
          const trimmed = part.trim()
          if (trimmed === '') return trimmed
          if (trimmed === 'body' || trimmed === 'html') return scope
          return `${scope} ${trimmed}`
        })
        .join(', ')
      rules.push(`${scoped} { ${body.trim()} }`)
    }
  }

  return rules.join('\n')
}

/**
 * Scopes a Note Type stylesheet to `scope`.
 *
 * Anki applies a Note Type's CSS to the whole review webview. nook renders
 * Cards inside its own page, so the same CSS would restyle the app. `body` and
 * `html` selectors become `scope`; every other selector is prefixed. Comments
 * are dropped, and `@font-face`/`@keyframes` bodies are left alone.
 */
export const scopeCss = (css: string, scope: string): string =>
  scopeRules(css.replace(/\/\*[\s\S]*?\*\//g, ''), scope).trim()
