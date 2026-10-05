import { Arbitrary, Schema } from 'effect'

/**
 * Generators shared by the property tests.
 *
 * `Arbitrary.schema` derives values from a Schema's decoded type, which is what
 * most of these tests want: the value nook stores, not the row Anki wrote.
 */

/**
 * Whether a string contains no unpaired surrogate.
 *
 * `String.prototype.isWellFormed` is the same check, but it is not in the lib
 * this package compiles against.
 */
const WELL_FORMED = /^(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\uD800-\uDFFF])*$/

/**
 * A string that survives UTF-8.
 *
 * The derived string arbitrary can produce an unpaired surrogate, which
 * `TextEncoder` and SQLite replace with U+FFFD. A property that sends a value
 * through protobuf bytes, a zip entry, or a SQLite column must not generate one,
 * so every such property uses this instead of the raw arbitrary.
 */
export const text = Arbitrary.schema(Schema.String).pipe(
  Arbitrary.filter((value) => WELL_FORMED.test(value)),
)

/** A string that is not empty, for a name, Tag, or Field. */
export const nonEmptyText = text.pipe(Arbitrary.filter((value) => value.length > 0))

/** A safe non-negative integer: the shape of every id, ordinal, and size. */
export const natural = Arbitrary.schema(Schema.Natural)

/** A 32-bit unsigned integer: the shape of an enum, ordinal, or count Anki writes. */
export const uint32 = Arbitrary.schema(
  Schema.Natural.check(Schema.isLessThanOrEqualTo(4_294_967_295)),
)

/** A byte, from 0 to 255. */
const byte = Arbitrary.schema(Schema.Natural.check(Schema.isLessThanOrEqualTo(255)))

/** A byte string of exactly `length` bytes, for a digest or a checksum. */
export const bytes = (length: number): Arbitrary.Arbitrary<Uint8Array> =>
  Arbitrary.array(byte, { minLength: length, maxLength: length }).pipe(
    Arbitrary.map((values) => Uint8Array.from(values)),
  )

/** A value that is present, or absent as `null`, the way a protobuf optional reads. */
export const optional = <A>(arbitrary: Arbitrary.Arbitrary<A>): Arbitrary.Arbitrary<A | null> =>
  Arbitrary.flatMap(Arbitrary.schema(Schema.Boolean), (present) =>
    present ? arbitrary : Arbitrary.Constant(null),
  )
