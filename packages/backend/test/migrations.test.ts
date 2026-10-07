import { describe, expect, it } from 'vitest'

describe('migrations stay append-only', () => {
  it('keeps the migration files this test knows about', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = path.join(import.meta.dirname, '..', 'migrations')
    const files = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
    expect(files).toEqual([
      '0001_schema.sql',
      '0002_showcase_seed.sql',
      '0003_import.sql',
      '0004_review.sql',
      '0005_day_boundary.sql',
      '0006_deck_limits.sql',
      '0007_leeches.sql',
    ])
  })
})
