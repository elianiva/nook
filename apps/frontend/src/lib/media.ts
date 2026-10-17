/**
 * The Worker's Media store: upload validation and hardened serving.
 *
 * Media comes from an archive the Learner picked, but the archive is still
 * untrusted: it is served from the app's own origin, so a stored HTML or SVG
 * file that rendered as a document would run script with the app's authority.
 * The stored content type is therefore never trusted. The type comes from the
 * file name's extension, only passive types may be uploaded, and everything
 * else is served sandboxed as a download.
 *
 * A file lives at `<importId>/<name>`. The archive's own name (`image1.jpg`)
 * is only unique inside one archive, so keying by it alone let one Deck's file
 * overwrite another's and the one-year cache froze whichever copy a device saw
 * first. An Import id is the SHA-256 of the archive, so a re-import of the same
 * file lands on the same keys. Files stored before the scoping sit at the bare
 * `<name>`: a scoped GET that misses falls back to it, and a bare-name GET reads
 * it. Such a key may hold another Deck's file, so it is never `immutable` and
 * carries `LEGACY_MEDIA_HEADER`, which the service worker refuses to cache.
 * Validation and the content type always follow the name, never the key.
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

/** Set on a response read from a pre-scoping key. */
export const LEGACY_MEDIA_HEADER = 'x-nook-media-legacy'

const IMPORT_ID = /^[0-9a-f]{64}$/

/** The browser URL for one Media file of one Import. */
export const mediaUrl = (importId: string, name: string): string =>
  `${MEDIA_PATH}/${importId}/${encodeURIComponent(name)}`

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

/** Splits a request path into the Import scope (null for a bare legacy path) and the decoded name. */
const parseMediaPath = (pathname: string): { scope: string | null; name: string } => {
  const rest = pathname.slice(MEDIA_PATH.length + 1)
  const slash = rest.indexOf('/')
  const scope = slash === -1 ? '' : rest.slice(0, slash)
  if (IMPORT_ID.test(scope) && slash < rest.length - 1) {
    return { scope, name: decodeURIComponent(rest.slice(slash + 1)) }
  }
  return { scope: null, name: decodeURIComponent(rest) }
}

export const mediaResponse = async (
  bucket: MediaBucket,
  request: Request,
  url: URL,
): Promise<Response> => {
  let parsed: { scope: string | null; name: string }
  try {
    parsed = parseMediaPath(url.pathname)
  } catch {
    return text(400, 'Bad media name')
  }
  const { scope, name } = parsed
  if (name === '') return text(404, 'Not found')
  if (!isValidMediaName(name)) return text(400, 'Bad media name')
  const key = scope === null ? name : `${scope}/${name}`

  if (request.method === 'GET' || request.method === 'HEAD') {
    let object = await bucket.get(key)
    let legacy = scope === null
    if (object === null && scope !== null) {
      object = await bucket.get(name)
      legacy = true
    }
    if (object === null) return text(404, 'Not found')
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    headers.set(
      'cache-control',
      legacy ? 'public, max-age=300' : 'public, max-age=31536000, immutable',
    )
    if (legacy) headers.set(LEGACY_MEDIA_HEADER, '1')
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
    await bucket.put(key, bytes, { httpMetadata: { contentType } })
    return new Response(null, { status: 204 })
  }

  return text(405, 'Method not allowed')
}
