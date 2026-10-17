import { describe, expect, it } from 'vitest'
import {
  MAX_MEDIA_BYTES,
  isValidMediaName,
  mediaResponse,
  type MediaBucket,
} from '../src/lib/media'

const fakeBucket = (stored: Record<string, string> = {}) => {
  const puts: { key: string; size: number; contentType?: string }[] = []
  const bucket: MediaBucket = {
    async get(key) {
      if (!(key in stored)) return null
      return {
        body: new Response(stored[key]).body!,
        httpEtag: '"e"',
        writeHttpMetadata: (h) => h.set('content-type', 'text/html'),
      }
    },
    async put(key, value, options) {
      puts.push({
        key,
        size: (value as Uint8Array).byteLength,
        contentType: options?.httpMetadata?.contentType,
      })
    },
  }
  return { bucket, puts }
}

const call = (bucket: MediaBucket, method: string, name: string, body?: BodyInit) => {
  const url = new URL(`https://nook.example.com/api/media/${name}`)
  return mediaResponse(bucket, new Request(url, { method, body }), url)
}

describe('media upload', () => {
  it('stores an image under the type its name implies, ignoring the client type', async () => {
    const { bucket, puts } = fakeBucket()
    const res = await call(bucket, 'PUT', 'cat.PNG', new Uint8Array([1, 2, 3]))
    expect(res.status).toBe(204)
    expect(puts).toEqual([{ key: 'cat.PNG', size: 3, contentType: 'image/png' }])
  })

  it.each(['page.html', 'x.js', 'noext', 'a.html.bin', 'constructor', 'x.__proto__'])(
    'rejects %s as an unsupported type',
    async (name) => {
      const { bucket, puts } = fakeBucket()
      expect((await call(bucket, 'PUT', name, 'x')).status).toBe(415)
      expect(puts).toEqual([])
    },
  )

  it.each(['a%2Fb.png', 'a%5Cb.png', 'a%00.png', '%E0%A4%A.png', `${'a'.repeat(256)}.png`])(
    'rejects the invalid name %s',
    async (name) => {
      const { bucket, puts } = fakeBucket()
      expect((await call(bucket, 'PUT', name, 'x')).status).toBe(400)
      expect(puts).toEqual([])
    },
  )

  it('rejects dot-segment names, which URL parsing would otherwise normalise away', () => {
    expect(isValidMediaName('..')).toBe(false)
    expect(isValidMediaName('.')).toBe(false)
  })

  it('accepts a file at the size limit and rejects one byte over', async () => {
    const { bucket, puts } = fakeBucket()
    expect((await call(bucket, 'PUT', 'a.png', new Uint8Array(MAX_MEDIA_BYTES))).status).toBe(204)
    expect((await call(bucket, 'PUT', 'b.png', new Uint8Array(MAX_MEDIA_BYTES + 1))).status).toBe(
      413,
    )
    expect(puts.map((p) => p.key)).toEqual(['a.png'])
  })

  it('enforces the limit on a streamed body with no content-length', async () => {
    const { bucket, puts } = fakeBucket()
    const url = new URL('https://nook.example.com/api/media/s.png')
    const chunk = new Uint8Array(MAX_MEDIA_BYTES / 2 + 1)
    const body = new ReadableStream({
      start(c) {
        c.enqueue(chunk)
        c.enqueue(chunk)
        c.close()
      },
    })
    const request = new Request(url, { method: 'PUT', body, duplex: 'half' } as RequestInit)
    expect((await mediaResponse(bucket, request, url)).status).toBe(413)
    expect(puts).toEqual([])
  })
})

describe('media serving', () => {
  it('serves an image inline with nosniff and the type from its name', async () => {
    const { bucket } = fakeBucket({ 'a.png': 'x' })
    const res = await call(bucket, 'GET', 'a.png')
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBeNull()
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  it.each(['evil.svg', 'evil.html', 'evil'])('sandboxes and downloads %s', async (name) => {
    const { bucket } = fakeBucket({ [name]: '<script>alert(1)</script>' })
    const res = await call(bucket, 'GET', name)
    expect(res.headers.get('content-type')).not.toMatch(/html/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
  })

  it('answers HEAD without a body and 404 for a missing name', async () => {
    const { bucket } = fakeBucket({ 'a.mp3': 'x' })
    const head = await call(bucket, 'HEAD', 'a.mp3')
    expect(head.headers.get('content-type')).toBe('audio/mpeg')
    expect(await head.text()).toBe('')
    expect((await call(bucket, 'GET', 'gone.png')).status).toBe(404)
  })
})
