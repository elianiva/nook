/**
 * The Worker's Media store: upload validation and hardened serving.
 *
 * Media comes from an archive the Learner picked, but the archive is still
 * untrusted: it is served from the app's own origin, so a stored HTML or SVG
 * file that rendered as a document would run script with the app's authority.
 * The stored content type is therefore never trusted. The type comes from the
 * file name's extension, only passive types may be uploaded, and everything
 * else is served sandboxed as a download.
 */

import { MEDIA_PATH } from './api'

/** The most one Media file may weigh. Anki's own limit for a single file is smaller. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024

const MAX_NAME_LENGTH = 255

/** Types a browser only decodes, never executes. These may be uploaded and render inline. */
const PASSIVE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

/** Types that can carry script when navigated to. They may be uploaded, since cards embed
 *  them with `<img>` (where script never runs), but are always served sandboxed. */
const ACTIVE_TYPES: Readonly<Record<string, string>> = {
  svg: 'image/svg+xml',
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

const own = (table: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined

/** The content type a name is allowed to be stored as, or null when it is not an allowed upload. */
export const uploadTypeFor = (name: string): string | null => {
  const ext = extensionOf(name)
  return own(PASSIVE_TYPES, ext) ?? own(ACTIVE_TYPES, ext) ?? null
}

/** A name is one path segment of printable text: no separators, no dot-segments, no controls. */
export const isValidMediaName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= MAX_NAME_LENGTH &&
  name !== '.' &&
  name !== '..' &&
  // oxlint-disable-next-line no-control-regex
  !/[/\\\u0000-\u001f\u007f]/.test(name)

const text = (status: number, body: string): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  })

/** Reads at most `limit` bytes of the body; null means it was larger. */
const readLimited = async (request: Request, limit: number): Promise<Uint8Array | null> => {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return null
  if (request.body === null) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * The slice of the R2 binding this module uses.
 *
 * It is typed with the DOM's `ReadableStream`/`Headers` rather than the Workers
 * types, which do not line up with `lib.dom`. The binding is the same object at
 * runtime; only the type differs.
 */
export type MediaObject = {
  body: ReadableStream
  httpEtag: string
  writeHttpMetadata(headers: Headers): void
}

export type MediaBucket = {
  get(key: string): Promise<MediaObject | null>
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array | null,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>
}

/**
 * Media is a Card's images and audio, keyed by the name the archive used.
 *
 * The Import writes each file with a PUT and the review screen reads it back
 * with a GET. Objects are immutable — a Media name identifies one file — so
 * they are cached hard.
 */
export const mediaResponse = async (
  bucket: MediaBucket,
  request: Request,
  url: URL,
): Promise<Response> => {
  let name: string
  try {
    name = decodeURIComponent(url.pathname.slice(MEDIA_PATH.length + 1))
  } catch {
    return text(400, 'Bad media name')
  }
  if (name === '') return text(404, 'Not found')
  if (!isValidMediaName(name)) return text(400, 'Bad media name')

  if (request.method === 'GET' || request.method === 'HEAD') {
    const object = await bucket.get(name)
    if (object === null) return text(404, 'Not found')
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    headers.set('cache-control', 'public, max-age=31536000, immutable')
    headers.set('x-content-type-options', 'nosniff')
    // The stored type is not trusted (older objects were all stored as
    // octet-stream); the name decides.
    const passive = own(PASSIVE_TYPES, extensionOf(name))
    if (passive !== undefined) {
      headers.set('content-type', passive)
    } else {
      headers.set(
        'content-type',
        own(ACTIVE_TYPES, extensionOf(name)) ?? 'application/octet-stream',
      )
      headers.set('content-security-policy', 'sandbox')
      headers.set('content-disposition', 'attachment; filename="media"')
    }
    return new Response(request.method === 'HEAD' ? null : object.body, { headers })
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const contentType = uploadTypeFor(name)
    if (contentType === null) return text(415, 'Unsupported media type')
    const bytes = await readLimited(request, MAX_MEDIA_BYTES)
    if (bytes === null) return text(413, 'Media too large')
    await bucket.put(name, bytes, { httpMetadata: { contentType } })
    return new Response(null, { status: 204 })
  }

  return text(405, 'Method not allowed')
}
