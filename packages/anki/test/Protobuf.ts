/**
 * A protobuf encoder for tests only. Nothing in nook writes protobuf, but every
 * message this package reads has to appear in a test as bytes, and building
 * them field by field keeps the tag numbers visible next to the assertions
 * instead of hiding them in a fixture nobody can read.
 */

import type { WireType } from '../src/Protobuf'

export const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export const varint = (value: number): Uint8Array => {
  const out: Array<number> = []
  let rest = value
  do {
    const byte = rest % 128
    rest = Math.floor(rest / 128)
    out.push(rest > 0 ? byte | 0x80 : byte)
  } while (rest > 0)
  return new Uint8Array(out)
}

const key = (fieldNumber: number, wireType: WireType): Uint8Array =>
  varint(fieldNumber * 8 + { varint: 0, fixed64: 1, lengthDelimited: 2, fixed32: 5 }[wireType])

export const uint32Field = (fieldNumber: number, value: number): Uint8Array =>
  concat(key(fieldNumber, 'varint'), varint(value))

export const boolField = (fieldNumber: number, value: boolean): Uint8Array =>
  concat(key(fieldNumber, 'varint'), varint(value ? 1 : 0))

export const stringField = (fieldNumber: number, value: string): Uint8Array => {
  const encoded = new TextEncoder().encode(value)
  return concat(key(fieldNumber, 'lengthDelimited'), varint(encoded.length), encoded)
}

export const bytesField = (fieldNumber: number, value: Uint8Array): Uint8Array =>
  concat(key(fieldNumber, 'lengthDelimited'), varint(value.length), value)

export const doubleField = (fieldNumber: number, value: number): Uint8Array => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setFloat64(0, value, true)
  return concat(key(fieldNumber, 'fixed64'), out)
}

export const floatField = (fieldNumber: number, value: number): Uint8Array => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setFloat32(0, value, true)
  return concat(key(fieldNumber, 'fixed32'), out)
}
