/**
 * A tiny `.apkg` the way Anki 26 writes one: a zip of a `meta` message and a
 * zstd-compressed SQLite collection. It reuses the collection writer and the
 * protobuf helpers `packages/anki/test` already trusts, so the archive differs
 * from a real export only in size.
 */
import { readFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js'
import { removeCollection, writeCollection } from '../../anki/test/Collection.ts'
import { concat, stringField, uint32Field } from '../../anki/test/Protobuf.ts'

export const DECK_NAME = 'E2E Smoke'

/** The Cards' fronts and backs, in the order the test expects to see them. */
export const CARDS = [
  { front: 'Capital of France', back: 'Paris' },
  { front: 'Capital of Japan', back: 'Tokyo' },
  { front: 'Capital of Kenya', back: 'Nairobi' },
] as const

export const buildApkg = async (): Promise<Buffer> => {
  const filename = writeCollection({
    decks: [
      { id: 1, name: 'Default' },
      { id: 2, name: DECK_NAME },
    ],
    noteTypes: [
      {
        id: 10,
        name: 'Basic',
        fields: [
          { name: 'Front', ord: 0 },
          { name: 'Back', ord: 1 },
        ],
        templates: [
          {
            name: 'Card 1',
            config: concat(
              stringField(1, '{{Front}}'),
              stringField(2, '{{FrontSide}}<hr id="answer">{{Back}}'),
            ),
          },
        ],
      },
    ],
    notes: CARDS.map((card, index) => ({
      id: 100 + index,
      noteTypeId: 10,
      fields: [card.front, card.back],
    })),
    cards: CARDS.map((_, index) => ({ id: 1000 + index, noteId: 100 + index, deckId: 2 })),
  })
  try {
    const writer = new ZipWriter(new BlobWriter('application/zip'))
    await writer.add('meta', new Uint8ArrayReader(uint32Field(1, 3)))
    await writer.add(
      'collection.anki21b',
      new Uint8ArrayReader(new Uint8Array(zstdCompressSync(readFileSync(filename)))),
    )
    // No Media: an empty `MediaEntries` message is zero bytes.
    await writer.add('media', new Uint8ArrayReader(new Uint8Array(0)))
    return Buffer.from(await (await writer.close()).arrayBuffer())
  } finally {
    removeCollection(filename)
  }
}
