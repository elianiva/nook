/**
 * `@nook/backend` — the server side of the contract.
 *
 * One module per feature area: the Effect services for that area, plus the
 * handlers they back. Handlers only translate a wire payload into a service
 * call and the result back into a wire payload. Scheduling rules, import
 * rules, and storage rules live in the services, never in a handler.
 *
 * D1 is reached through `SqlLive`, which adapts a `D1Database` binding into
 * the `SqlClient` every service reads from.
 */

export { Decks, DecksHandlers } from './decks'
export { Home, HomeHandlers } from './home'
export { Settings, SettingsHandlers } from './settings'
export { SqlLive } from './sql'
export { withStorageErrorPassThrough, decodeRows } from './storage-error'
