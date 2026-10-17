-- Which Import's Media a Note renders from.
--
-- Media is stored under `<importId>/<name>`, and a Note's `import_id` moves to
-- the latest Import that wrote it. A later archive that re-imports the Note
-- with its Media excluded uploads nothing under its own id, so following
-- `import_id` would 404 files that exist under the earlier Import.
--
-- NULL means the Note's Media lives under its `import_id`. It is set only when
-- a re-import without Media takes the Note over, and points at the Import
-- whose files the Note was already using.

ALTER TABLE notes ADD COLUMN media_import_id TEXT REFERENCES imports (id);
