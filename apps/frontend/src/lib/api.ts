/** Every path the API Worker answers, in one table. `worker.ts` matches
 *  against these and the browser builds its URLs from them, so a route cannot
 *  exist on one side only. All of them sit under `/api`, the prefix the
 *  asset layer hands to the Worker first. */
export const API_PREFIX = '/api'

/** Liveness. */
export const HEALTH_PATH = `${API_PREFIX}/health`

/** The one route every RPC procedure shares. The browser's RPC client posts
 *  here; `worker.ts` serves the group beside it. */
export const RPC_PATH = `${API_PREFIX}/rpc`

/** Media is served by the Worker from R2, outside the RPC group. */
export const MEDIA_PATH = `${API_PREFIX}/media`
