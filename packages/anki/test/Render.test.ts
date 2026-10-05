import { describe, expect, it } from '@effect/vitest'
import { renderCard, scopeCss } from '../src/Render'
import type { RenderNoteType } from '../src/Render'

const basic: RenderNoteType = {
  name: 'Basic',
  kind: 'normal',
  css: '.card { font-size: 20px }',
  fields: [
    { name: 'Front', ord: 0 },
    { name: 'Back', ord: 1 },
  ],
  templates: [
    {
      name: 'Card 1',
      ord: 0,
      questionFormat: '{{Front}}',
      answerFormat: '{{FrontSide}}<hr id=answer>{{Back}}',
    },
  ],
}

const renderBasic = (
  fields: ReadonlyArray<string>,
  overrides: Partial<Parameters<typeof renderCard>[0]> = {},
) =>
  renderCard({
    noteType: basic,
    note: { fields, tags: [] },
    templateOrd: 0,
    deckName: 'Japanese::Vocab',
    ...overrides,
  })

describe('renderCard', () => {
  it('substitutes Fields and repeats the question through FrontSide', () => {
    const card = renderBasic(['おはよう', 'Good morning'])
    expect(card.question).toBe('おはよう')
    expect(card.answer).toBe('おはよう<hr id=answer>Good morning')
  })

  it('strips HTML with the text: filter but keeps it otherwise', () => {
    const noteType: RenderNoteType = {
      ...basic,
      templates: [
        { name: 'Card 1', ord: 0, questionFormat: '{{text:Front}}', answerFormat: '{{Front}}' },
      ],
    }
    const card = renderCard({
      noteType,
      note: { fields: ['<b>bold</b>'], tags: [] },
      templateOrd: 0,
      deckName: 'Deck',
    })
    expect(card.question).toBe('bold')
    expect(card.answer).toBe('<b>bold</b>')
  })

  it('renders conditionals on non-empty and empty Fields', () => {
    const noteType: RenderNoteType = {
      ...basic,
      templates: [
        {
          name: 'Card 1',
          ord: 0,
          questionFormat: '{{#Back}}has back{{/Back}}{{^Back}}no back{{/Back}}',
          answerFormat: '',
        },
      ],
    }
    const withBack = renderCard({
      noteType,
      note: { fields: ['front', 'back'], tags: [] },
      templateOrd: 0,
      deckName: 'Deck',
    })
    expect(withBack.question).toBe('has back')

    const withoutBack = renderCard({
      noteType,
      note: { fields: ['front', '  <br> '], tags: [] },
      templateOrd: 0,
      deckName: 'Deck',
    })
    expect(withoutBack.question).toBe('no back')
  })

  it('injects the special Fields', () => {
    const noteType: RenderNoteType = {
      ...basic,
      templates: [
        {
          name: 'Recognition',
          ord: 0,
          questionFormat: '{{Deck}}|{{Subdeck}}|{{Card}}|{{Type}}|{{Tags}}',
          answerFormat: '',
        },
      ],
    }
    const card = renderCard({
      noteType,
      note: { fields: ['a', 'b'], tags: ['vocab', 'n5'] },
      templateOrd: 0,
      deckName: 'Japanese::Vocab',
    })
    expect(card.question).toBe('Japanese::Vocab|Vocab|Recognition|Basic|vocab n5')
  })

  it('hides the target cloze on the question and reveals it on the answer', () => {
    const cloze: RenderNoteType = {
      name: 'Cloze',
      kind: 'cloze',
      css: '.cloze { color: blue }',
      fields: [{ name: 'Text', ord: 0 }],
      templates: [
        { name: 'Cloze', ord: 0, questionFormat: '{{cloze:Text}}', answerFormat: '{{cloze:Text}}' },
      ],
    }
    const note = { fields: ['The {{c1::word}} is {{c2::defined}}'], tags: [] }

    const first = renderCard({ noteType: cloze, note, templateOrd: 0, deckName: 'Deck' })
    expect(first.question).toContain('[.')
    expect(first.question).toContain('defined')
    expect(first.question).not.toContain('word')

    const second = renderCard({ noteType: cloze, note, templateOrd: 1, deckName: 'Deck' })
    expect(second.question).toContain('word')
    expect(second.question).toContain('[.')
    expect(second.question).not.toContain('defined')

    expect(first.answer).toContain('word')
    expect(first.answer).toContain('defined')
  })

  it('uses the cloze hint when the cloze carries one', () => {
    const cloze: RenderNoteType = {
      name: 'Cloze',
      kind: 'cloze',
      css: '',
      fields: [{ name: 'Text', ord: 0 }],
      templates: [
        { name: 'Cloze', ord: 0, questionFormat: '{{cloze:Text}}', answerFormat: '{{cloze:Text}}' },
      ],
    }
    const card = renderCard({
      noteType: cloze,
      note: { fields: ['{{c1::Tokyo::city}}'], tags: [] },
      templateOrd: 0,
      deckName: 'Deck',
    })
    expect(card.question).toContain('[city]')
  })

  it('renders nothing for a cloze ordinal the text does not carry', () => {
    const cloze: RenderNoteType = {
      name: 'Cloze',
      kind: 'cloze',
      css: '',
      fields: [{ name: 'Text', ord: 0 }],
      templates: [
        { name: 'Cloze', ord: 0, questionFormat: '{{cloze:Text}}', answerFormat: '{{cloze:Text}}' },
      ],
    }
    const card = renderCard({
      noteType: cloze,
      note: { fields: ['only {{c1::one}}'], tags: [] },
      templateOrd: 1,
      deckName: 'Deck',
    })
    expect(card.question).toBe('')
  })

  it('rewrites [sound:] tags and relative media URLs', () => {
    const mediaUrl = (name: string) => `/api/media/${encodeURIComponent(name)}`
    const card = renderBasic(['<img src="cat.jpg">', '[sound:hello world.mp3]'], { mediaUrl })
    expect(card.question).toBe('<img src="/api/media/cat.jpg">')
    expect(card.answer).toContain('src="/api/media/hello%20world.mp3"')
    expect(card.answer).not.toContain('[sound:')
  })

  it('leaves absolute media URLs alone', () => {
    const card = renderBasic(['<img src="https://example.com/cat.jpg">'], {
      mediaUrl: (name) => `/api/media/${name}`,
    })
    expect(card.question).toBe('<img src="https://example.com/cat.jpg">')
  })
})

describe('scopeCss', () => {
  it('scopes plain selectors and rewrites body to the scope', () => {
    const scoped = scopeCss('body { font-size: 20px } .cloze { color: blue }', '#nook-card')
    expect(scoped).toBe('#nook-card { font-size: 20px }\n#nook-card .cloze { color: blue }')
  })

  it('scopes comma-separated selectors', () => {
    expect(scopeCss('b, i { color: red }', '#qa')).toBe('#qa b, #qa i { color: red }')
  })

  it('recurses into @media but leaves @keyframes alone', () => {
    const scoped = scopeCss(
      '@media (max-width: 600px) { .card { font-size: 14px } }\n@keyframes fade { from { opacity: 0 } }',
      '#qa',
    )
    expect(scoped).toContain('@media (max-width: 600px) {\n#qa .card { font-size: 14px }\n}')
    expect(scoped).toContain('@keyframes fade { from { opacity: 0 } }')
  })
})
