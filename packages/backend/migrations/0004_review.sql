-- FSRS scheduling state, plus a showcase deck that renders.
--
-- `due_in_days` said "the interval", but nothing aged: a Card due in three days
-- stayed due in three days forever. `due_at` is the absolute instant, so due-ness
-- is a comparison against now. `reps`, `lapses`, and `last_reviewed_at` are what
-- FSRS reads to know how much of a Card has been forgotten.
--
-- The showcase deck gains a real Note Type, real Notes, and Cards that point at
-- them, so the review flow has something to render before the first Import.

ALTER TABLE cards ADD COLUMN due_at TEXT;
ALTER TABLE cards ADD COLUMN reps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN lapses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN last_reviewed_at TEXT;
CREATE INDEX cards_due_at_idx ON cards (due_at);

-- FSRS-6 carries 21 weights. The original row held the first 17, which cannot
-- drive the short-term and decay terms.
UPDATE settings SET fsrs_weights = '0.212,1.2931,2.3065,8.2956,6.4133,0.8334,3.0194,0.001,1.8722,0.1666,0.796,1.4835,0.0614,0.2629,1.6483,0.6014,1.8729,0.5425,0.0912,0.0658,0.1542'
WHERE id = 1;

INSERT INTO note_types (id, name, kind, sort_field_ord, css, fields, templates) VALUES (
  'showcase-nt-basic',
  'Basic (Showcase)',
  'normal',
  0,
  '.card { font-family: system-ui, -apple-system, sans-serif; font-size: 22px; text-align: center; color: #0f172a; }
.cloze { font-weight: 700; color: #2563eb; }
.cloze-inactive { color: #64748b; }
b, strong { color: #2563eb; }
hr#answer { border: none; border-top: 1px solid #e2e8f0; margin: 16px 0; }',
  '[{"ord":0,"name":"Front","rightToLeft":false,"fontName":null,"fontSize":null,"plainText":false,"description":"","sticky":true},{"ord":1,"name":"Back","rightToLeft":false,"fontName":null,"fontSize":null,"plainText":false,"description":"","sticky":false}]',
  '[{"ord":0,"name":"Card 1","questionFormat":"{{Front}}","answerFormat":"{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}","deckId":0}]'
);

INSERT INTO note_types (id, name, kind, sort_field_ord, css, fields, templates) VALUES (
  'showcase-nt-cloze',
  'Cloze (Showcase)',
  'cloze',
  0,
  '.card { font-family: system-ui, -apple-system, sans-serif; font-size: 22px; text-align: center; color: #0f172a; }
.cloze { font-weight: 700; color: #2563eb; }
.cloze-inactive { color: #64748b; }
b, strong { color: #2563eb; }
hr#answer { border: none; border-top: 1px solid #e2e8f0; margin: 16px 0; }',
  '[{"ord":0,"name":"Text","rightToLeft":false,"fontName":null,"fontSize":null,"plainText":false,"description":"","sticky":true}]',
  '[{"ord":0,"name":"Cloze","questionFormat":"{{cloze:Text}}","answerFormat":"{{cloze:Text}}\n\n<hr id=answer>\n\n{{cloze:Text}}","deckId":0}]'
);

-- The seeded Notes name an Import so the foreign key holds. Nothing reads it
-- back: it exists only to satisfy `notes.import_id`.
INSERT INTO imports (id, filename, status, note_count, card_count, media_count) VALUES
  ('showcase', 'Showcase deck', 'done', 8, 8, 0);

INSERT INTO notes (id, note_type_id, guid, fields, tags, modified, import_id) VALUES
  ('showcase-note-1', 'showcase-nt-basic', 'showcase-guid-1', '["おはよう","Good morning"]', '["japanese","greeting"]', 0, 'showcase'),
  ('showcase-note-2', 'showcase-nt-basic', 'showcase-guid-2', '["ありがとう","Thank you"]', '["japanese","greeting"]', 0, 'showcase'),
  ('showcase-note-3', 'showcase-nt-basic', 'showcase-guid-3', '["すみません","Excuse me"]', '["japanese","greeting"]', 0, 'showcase'),
  ('showcase-note-4', 'showcase-nt-basic', 'showcase-guid-4', '["いただきます","Thanks for the meal, before eating"]', '["japanese","greeting"]', 0, 'showcase'),
  ('showcase-note-5', 'showcase-nt-basic', 'showcase-guid-5', '["ごちそうさま","Thanks for the meal, after eating"]', '["japanese","greeting"]', 0, 'showcase'),
  ('showcase-note-6', 'showcase-nt-basic', 'showcase-guid-6', '["おやすみなさい","Good night"]', '["japanese","greeting"]', 0, 'showcase'),
  ('showcase-note-7', 'showcase-nt-cloze', 'showcase-guid-7', '["東京は{{c1::日本の首都}}です。"]', '["japanese","geography"]', 0, 'showcase'),
  ('showcase-note-8', 'showcase-nt-cloze', 'showcase-guid-8', '["富士山は{{c1::日本}}で{{c2::一番高い}}山です。"]', '["japanese","geography"]', 0, 'showcase');

-- Point the seeded Cards at their Notes and give them a real due instant.
-- Instants are ISO 8601 UTC, which `julianday` and `Date` both parse and which
-- sorts lexicographically against `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`.
UPDATE cards SET note_id = 'showcase-note-1', template_ord = 0, reps = 4, lapses = 0, last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day'), due_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = 'card-showcase-01';
UPDATE cards SET note_id = 'showcase-note-2', template_ord = 0, reps = 3, lapses = 0, last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 days'), due_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 days') WHERE id = 'card-showcase-02';
UPDATE cards SET note_id = 'showcase-note-3', template_ord = 0, reps = 2, lapses = 0, last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day'), due_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 day') WHERE id = 'card-showcase-03';
UPDATE cards SET note_id = 'showcase-note-4', template_ord = 0, reps = 1, lapses = 1, last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day'), due_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = 'card-showcase-04';
UPDATE cards SET note_id = 'showcase-note-5', template_ord = 0, reps = 0, lapses = 0, last_reviewed_at = NULL, due_at = NULL WHERE id = 'card-showcase-05';
UPDATE cards SET note_id = 'showcase-note-6', template_ord = 0, reps = 0, lapses = 0, last_reviewed_at = NULL, due_at = NULL WHERE id = 'card-showcase-06';
UPDATE cards SET note_id = 'showcase-note-7', template_ord = 0, reps = 5, lapses = 0, last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day'), due_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+4 days') WHERE id = 'card-showcase-07';
UPDATE cards SET note_id = 'showcase-note-8', template_ord = 1, reps = 2, lapses = 1, last_reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day'), due_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = 'card-showcase-08';
