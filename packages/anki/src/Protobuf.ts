/**
 * A reader for the protobuf wire format, covering the four Anki messages this
 * package decodes.
 *
 * Anki writes those messages with prost, which emits every field and skips
 * nothing, so a decoder that walks the whole message and ignores the fields it
 * does not know stays correct when Anki adds one.
 *
 * Every read is exact for the values Anki stores. Ids are millisecond
 * timestamps, sizes are file sizes, and ordinals are small, so all of them sit
 * well inside the safe integer range and a varint fits in a `number`.
 */

/** How a field's value is encoded on the wire. */
export type WireType = 'varint' | 'fixed64' | 'lengthDelimited' | 'fixed32'

/** The key that introduces a field: its number, and how its value is encoded. */
export interface ProtobufTag {
  readonly number: number
  readonly wireType: WireType
}

const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH_DELIMITED = 2
const WIRE_FIXED32 = 5

const wireTypeOf = (value: number, offset: number): WireType => {
  switch (value) {
    case WIRE_VARINT:
      return 'varint'
    case WIRE_FIXED64:
      return 'fixed64'
    case WIRE_LENGTH_DELIMITED:
      return 'lengthDelimited'
    case WIRE_FIXED32:
      return 'fixed32'
    default:
      throw new ProtobufError(
        `field uses wire type ${value}, which this reader does not accept`,
        offset,
      )
  }
}

const utf8 = new TextDecoder()

/** A message that is truncated or not protobuf at all. */
export class ProtobufError extends Error {
  /** Where in the message the reader gave up. */
  readonly offset: number

  constructor(message: string, offset: number) {
    super(`${message} at byte ${offset}`)
    this.name = 'ProtobufError'
    this.offset = offset
  }
}

export class ProtobufReader {
  readonly #bytes: Uint8Array
  readonly #view: DataView
  #offset = 0

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  /** True once every byte of the message has been read. */
  get done(): boolean {
    return this.#offset >= this.#bytes.length
  }

  /**
   * The next field's key, or `null` at the end of the message. Read the value
   * that follows, or call `skip`.
   */
  next(): ProtobufTag | null {
    if (this.done) {
      return null
    }
    const key = this.varint()
    return { number: Math.floor(key / 8), wireType: wireTypeOf(key % 8, this.#offset) }
  }

  /** A base 128 integer. `bool`, `enum`, `uint32`, and `int64` all arrive this way. */
  varint(): number {
    let value = 0
    let scale = 1
    for (;;) {
      const byte = this.#byte()
      value += (byte & 0x7f) * scale
      if ((byte & 0x80) === 0) {
        return value
      }
      scale *= 128
      if (scale > Number.MAX_SAFE_INTEGER) {
        throw new ProtobufError('a varint runs on past the safe integer range', this.#offset)
      }
    }
  }

  bool(): boolean {
    return this.varint() !== 0
  }

  string(): string {
    return utf8.decode(this.bytes())
  }

  /**
   * A length-delimited value, as a view over the same buffer. protobuf
   * `string` and `bytes` fields, and nested messages, all arrive this way.
   */
  bytes(): Uint8Array {
    const length = this.varint()
    const start = this.#offset
    const end = start + length
    if (end > this.#bytes.length) {
      throw new ProtobufError(`a value of ${length} bytes runs past the end of the message`, start)
    }
    this.#offset = end
    return this.#bytes.subarray(start, end)
  }

  float(): number {
    return this.#view.getFloat32(this.#take(4), true)
  }

  double(): number {
    return this.#view.getFloat64(this.#take(8), true)
  }

  /** Steps over a field whose number this decoder does not know. */
  skip(tag: ProtobufTag): void {
    switch (tag.wireType) {
      case 'varint':
        this.#skipVarint()
        return
      case 'fixed64':
        this.#take(8)
        return
      case 'lengthDelimited':
        this.bytes()
        return
      case 'fixed32':
        this.#take(4)
        return
    }
  }

  /**
   * Steps over a varint without computing its value.
   *
   * An unknown `int64` field can hold a value a `number` cannot carry exactly:
   * Anki 23.10 writes `Field.Config.id` and `Template.Config.id` as random
   * 64-bit ids, which run to ten bytes and often negative. `varint` refuses
   * those, because a known field is always small enough to read exactly, but
   * skipping needs only the field's length, not its value.
   */
  #skipVarint(): void {
    for (let length = 1; ; length++) {
      if ((this.#byte() & 0x80) === 0) {
        return
      }
      if (length === 10) {
        // A 64-bit varint is ten bytes at most, so an eleventh means malformed.
        throw new ProtobufError('a varint runs past ten bytes', this.#offset)
      }
    }
  }

  #byte(): number {
    const offset = this.#offset
    if (offset >= this.#bytes.length) {
      throw new ProtobufError('the message ends in the middle of a value', offset)
    }
    this.#offset = offset + 1
    return this.#view.getUint8(offset)
  }

  #take(length: number): number {
    const start = this.#offset
    const end = start + length
    if (end > this.#bytes.length) {
      throw new ProtobufError(
        `a fixed-width value of ${length} bytes runs past the end of the message`,
        start,
      )
    }
    this.#offset = end
    return start
  }
}
