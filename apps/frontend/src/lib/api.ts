/** Every path the API Worker answers, in one table. `worker.ts` matches
 *  against these and the browser builds its URLs from them, so a route cannot
 *  exist on one side only. All of them sit under `/api`, the prefix the
 *  asset layer hands to the Worker first. */
export const API_PREFIX = '/api'

/** Liveness. */
export const HEALTH_PATH = `${API_PREFIX}/health`

/** OpenAPI document for the HttpApi, served by the Worker. */
export const OPENAPI_PATH = `${API_PREFIX}/openapi.json`

/** Every path the Worker answers, kept beside the prefix they share. */
export const API_PATHS = {
  health: HEALTH_PATH,
  openapi: OPENAPI_PATH,
  decks: `${API_PREFIX}/decks`,
  home: `${API_PREFIX}/home`,
  settings: `${API_PREFIX}/settings`,
} as const
