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

describe('ProtobufReader', () => {
  it('reads a varint that fits in one byte', () => {
    const reader = new ProtobufReader(uint32Field(1, 3))
    expect(reader.next()).toEqual({ number: 1, wireType: 'varint' })
    expect(reader.varint()).toBe(3)
    expect(reader.done).toBe(true)
  })

  it('reads a varint that Anki writes as a millisecond timestamp', () => {
    const reader = new ProtobufReader(uint32Field(1, 1_706_642_722_425))
    reader.next()
    expect(reader.varint()).toBe(1_706_642_722_425)
  })

  it('reads a string, including characters outside ASCII', () => {
    const reader = new ProtobufReader(stringField(3, '.card { font-family: "游ゴシック" }'))
    reader.next()
    expect(reader.string()).toBe('.card { font-family: "游ゴシック" }')
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
