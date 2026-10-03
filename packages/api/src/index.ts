/**
 * `@nook/api` — the contract and the data model.
 *
 * Everything the browser and the Worker must agree on lives here:
 *
 * - the Effect RPC contract, one `RpcGroup` per feature area
 * - the Drizzle schema for D1, and the types Drizzle infers from it
 * - the domain types that cross the network boundary
 *
 * This package stays free of runtime behaviour. The browser bundle imports it,
 * so anything that needs a database client, a bucket, a clock, or a request
 * belongs in `@nook/backend` instead.
 */

export {}
