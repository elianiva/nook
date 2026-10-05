import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Effect } from 'effect'

/**
 * The Kaishi 1.5k export, the real Anki archive the reader is tested against.
 *
 * A hand-built archive proves the reader agrees with its author; this proves it
 * agrees with Anki. It carries what a real Anki 25.x export carries: the random
 * `int64` ids Anki 23.10 writes into Field and Template configs, one Note Type
 * with fourteen Fields, 1501 Notes and Cards, and 4354 Media files. See
 * `fixtures/README.md` for why it is not committed.
 */
export const KAISHI_URL =
  'https://github.com/donkuri/kaishi/releases/download/v2.4.3/Kaishi.1.5k.v2.4.3.apkg'

/** The SHA-256 of the archive at {@link KAISHI_URL}, checked after downloading. */
export const KAISHI_SHA256 = '33da6f5a8b5d5cf12ccd79f6279775fc44b1de54159aad189a2e691386fce464'

/** Where the fixture lives, beside the tests that use it. */
export const KAISHI_PATH = new URL('./fixtures/Kaishi.1.5k.v2.4.3.apkg', import.meta.url)

const FIXTURES = new URL('./fixtures/', import.meta.url)

const download = (): Effect.Effect<Uint8Array, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(KAISHI_URL)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return new Uint8Array(await response.arrayBuffer())
    },
    catch: (cause) => new Error(`could not download ${KAISHI_URL}: ${String(cause)}`),
  })

const verify = (bytes: Uint8Array): Effect.Effect<Uint8Array, Error> => {
  const digest = createHash('sha256').update(bytes).digest('hex')
  return digest === KAISHI_SHA256
    ? Effect.succeed(bytes)
    : Effect.fail(new Error(`the Kaishi archive hashes to ${digest}, expected ${KAISHI_SHA256}`))
}

/**
 * The Kaishi archive, read from `test/fixtures` or downloaded there once.
 *
 * The cached copy is written only after the download verifies against
 * {@link KAISHI_SHA256}, so a truncated download is never cached. A test that
 * needs the archive fails with the download error and nothing else.
 */
export const kaishiArchive = (): Effect.Effect<Blob, Error> =>
  Effect.gen(function* () {
    const cached = yield* Effect.promise(() => readFile(KAISHI_PATH).catch(() => undefined))
    if (cached !== undefined) {
      // `Uint8Array.from` narrows the Buffer's `ArrayBufferLike` to an
      // `ArrayBuffer`, which is the only buffer a `Blob` accepts.
      return new Blob([Uint8Array.from(cached)])
    }
    const bytes = yield* verify(yield* download())
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(FIXTURES, { recursive: true })
        await writeFile(KAISHI_PATH, bytes)
      },
      catch: (cause) => new Error(`could not cache the Kaishi archive: ${String(cause)}`),
    })
    return new Blob([Uint8Array.from(bytes)])
  })
