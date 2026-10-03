/**
 * `@nook/backend` — the server side of the contract.
 *
 * One module per feature area: the Effect RPC handlers for that area, plus the
 * services they call. Handlers only translate a wire payload into a service
 * call and the result back into a wire payload. Scheduling rules, import rules,
 * and storage rules live in the services, never in a handler.
 *
 * D1 and R2 are reached through a single Effect service each, so no Drizzle
 * call appears outside the module that owns it.
 */

export {}
