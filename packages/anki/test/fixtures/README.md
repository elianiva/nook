# Anki fixtures

## `Kaishi.1.5k.v2.4.3.apkg`

The real export nook's archive reader is tested against.

|         |                                                                                      |
| ------- | ------------------------------------------------------------------------------------ |
| Deck    | Kaishi 1.5k                                                                          |
| Version | v2.4.3                                                                               |
| Source  | <https://github.com/donkuri/kaishi/releases/download/v2.4.3/Kaishi.1.5k.v2.4.3.apkg> |
| SHA-256 | `33da6f5a8b5d5cf12ccd79f6279775fc44b1de54159aad189a2e691386fce464`                   |
| Size    | 103.7 MiB                                                                            |

A hand-built archive only proves the reader agrees with its author. A real
export proves it agrees with Anki, and this one caught two bugs that no
hand-built archive had shown:

- Anki 23.10 writes a random `int64` id into every Field and Template config.
  `ProtobufReader.skip` refused values that do not fit in a safe `number`, so
  the whole archive failed to open.
- Every Media file arrives in its own zstd frame. The reader streamed that
  frame, so the Import would have stored files nothing can open.

The file is not committed. At 103.7 MiB it is over GitHub's 100 MiB limit for a
tracked file, and it is almost all Media audio that the reader treats as opaque.
`test/Kaishi.ts` downloads it into this directory on first use and checks the
SHA-256 above, so the tests need the network once.
