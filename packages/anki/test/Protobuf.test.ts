import { describe, expect, it } from '@effect/vitest'
import { ProtobufError, ProtobufReader } from '../src/Protobuf'
import {
  boolField,
  bytesField,
  concat,
  doubleField,
  floatField,
  stringField,
  uint32Field,
} from './Protobuf'
import { natural, text } from './Generators'

/** A message built from hex, for values the test encoder cannot write. */
const hex = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/../g) ?? [], (byte) => parseInt(byte, 16))

describe('ProtobufReader', () => {
  it.prop('reads back every varint value it can carry', [natural], ([value]) => {
    const reader = new ProtobufReader(uint32Field(1, value))
    reader.next()
    expect(reader.varint()).toBe(value)
  })

  it.prop('reads back every string, including characters outside ASCII', [text], ([value]) => {
    const reader = new ProtobufReader(stringField(3, value))
    reader.next()
    expect(reader.string()).toBe(value)
  })

  it('reads a bool as a varint', () => {
    const reader = new ProtobufReader(concat(boolField(2, true), boolField(7, false)))
    reader.next()
    expect(reader.bool()).toBe(true)
    reader.next()
    expect(reader.bool()).toBe(false)
  })

  it('reads raw bytes as a view over the same buffer, not a copy', () => {
    const message = bytesField(3, new Uint8Array([1, 2, 3]))
    const reader = new ProtobufReader(message)
    reader.next()
    const value = reader.bytes()
    expect([...value]).toEqual([1, 2, 3])
    expect(value.buffer).toBe(message.buffer)
  })

  it('reads a fixed 64-bit and a fixed 32-bit value, little-endian', () => {
    const reader = new ProtobufReader(concat(doubleField(1, 0.5), floatField(2, 0.25)))
    reader.next()
    expect(reader.double()).toBe(0.5)
    reader.next()
    expect(reader.float()).toBe(0.25)
  })

  it('walks fields in the order Anki wrote them', () => {
    const reader = new ProtobufReader(
      concat(uint32Field(1, 1), stringField(2, 'a'), uint32Field(15, 2)),
    )
    const numbers: Array<number> = []
    for (let tag = reader.next(); tag !== null; tag = reader.next()) {
      numbers.push(tag.number)
      reader.skip(tag)
    }
    expect(numbers).toEqual([1, 2, 15])
  })

  it('skips a field it does not know, whatever its wire type', () => {
    const reader = new ProtobufReader(
      concat(
        uint32Field(200, 9),
        stringField(201, 'unknown'),
        doubleField(202, 1.5),
        uint32Field(1, 7),
      ),
    )
    for (let tag = reader.next(); tag !== null; tag = reader.next()) {
      if (tag.number === 1) {
        expect(reader.varint()).toBe(7)
      } else {
        reader.skip(tag)
      }
    }
    expect(reader.done).toBe(true)
  })

  it('steps over an unknown 64-bit varint without carrying it', () => {
    // Anki 23.10 writes a random `int64` id into every Field and Template
    // config. These are the real bytes from Kaishi: one positive, one negative.
    const reader = new ProtobufReader(
      concat(
        uint32Field(1, 7),
        new Uint8Array([0x48]),
        hex('98c4c4ffec8d89e534'),
        new Uint8Array([0x48]),
        hex('ffffffffffffffffff01'),
      ),
    )
    const numbers: Array<number> = []
    for (let tag = reader.next(); tag !== null; tag = reader.next()) {
      numbers.push(tag.number)
      if (tag.number === 1) {
        expect(reader.varint()).toBe(7)
      } else {
        reader.skip(tag)
      }
    }
    expect(numbers).toEqual([1, 9, 9])
    expect(reader.done).toBe(true)
  })

  it('refuses a skipped varint that runs past ten bytes', () => {
    const reader = new ProtobufReader(concat(new Uint8Array([0x48]), new Uint8Array(11).fill(0x80)))
    const tag = reader.next()
    expect(tag).not.toBeNull()
    expect(() => reader.skip(tag!)).toThrow(ProtobufError)
  })

  it('stops at the end of the message', () => {
    expect(new ProtobufReader(new Uint8Array(0)).next()).toBeNull()
  })

  it('refuses a value that runs past the end of the message', () => {
    const reader = new ProtobufReader(new Uint8Array([0x0a, 0x20, 0x01]))
    reader.next()
    expect(() => reader.bytes()).toThrow(ProtobufError)
  })

  it('refuses a varint that never ends', () => {
    const reader = new ProtobufReader(new Uint8Array([0x08, 0x80, 0x80, 0x80]))
    reader.next()
    expect(() => reader.varint()).toThrow(ProtobufError)
  })

  it('refuses the group wire types, which Anki never writes', () => {
    const reader = new ProtobufReader(new Uint8Array([0x0b]))
    expect(() => reader.next()).toThrow(ProtobufError)
  })

  it('says where it gave up, so a corrupt blob can be reported', () => {
    const reader = new ProtobufReader(new Uint8Array([0x0a, 0x20, 0x01]))
    reader.next()
    try {
      reader.bytes()
      expect.unreachable('the reader should have refused a truncated value')
    } catch (error) {
      expect(error).toBeInstanceOf(ProtobufError)
      // byte 0 is the key, byte 1 the length, so the value starts at byte 2.
      expect((error as ProtobufError).offset).toBe(2)
    }
  })
})
