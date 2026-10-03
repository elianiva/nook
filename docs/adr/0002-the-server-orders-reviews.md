# The server orders Reviews

Every Review carries a client-generated id, and the server appends it to a
per-Learner log in arrival order. A replayed id is ignored, so a device that
reconnects after being offline applies each grade exactly once.

We chose this over last-write-wins on the client timestamp, because client
clocks lie and FSRS is sensitive to when a Review happened, and over merging
both devices' Reviews, which corrupts the inputs the scheduler learns from.

## Consequences

The log is append-only, and Card state is derived from it rather than
overwritten. Changing this protocol after two devices exist is a compatibility
problem, not a refactor.
