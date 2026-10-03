/**
 * Hex, and the form Anki writes every checksum in.
 *
 * Anki stores each Media file's SHA-1 in its Media index, so a reader can carry
 * that digest alongside the file and let the caller decide whether to check it.
 * Computing the digest needs the platform's `crypto.subtle`, which is
 * asynchronous and belongs to the streaming layer rather than here.
 */

const HEX = '0123456789abcdef'

/** A byte string as lowercase hex. */
export const toHex = (bytes: Uint8Array): string => {
  let hex = ''
  for (const byte of bytes) {
    hex += HEX.charAt(byte >> 4) + HEX.charAt(byte & 0x0f)
  }
  return hex
}
