import type { D1Database } from '@cloudflare/workers-types'
import { Config, Layer } from 'effect'
import { D1Client } from '@effect/sql-d1'
import * as Sql from 'effect/sql/SqlClient'

/** Adapt a Worker's `D1Database` binding into the `SqlClient` every service reads from. */
export const SqlLive = (
  db: D1Database,
): Layer.Layer<D1Client.D1Client | Sql.SqlClient, Config.ConfigError> => D1Client.layer({ db })
