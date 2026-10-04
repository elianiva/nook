-- Showcase deck: proves the UI end to end without an .apkg Import.
-- Deferred Import work replaces this seed, not the schema.

INSERT INTO decks (id, name, description, due_delta, last_studied_at, retention_7d)
VALUES (
  'deck-showcase-japanese',
  'Showcase Japanese',
  'Demo deck — real rows, no Import needed',
  3,
  date('now', '-1 day'),
  75
);

INSERT INTO cards (id, deck_id, due_in_days, stability, difficulty, state) VALUES
  ('card-showcase-01', 'deck-showcase-japanese', 0, 2.4, 5, 'review'),
  ('card-showcase-02', 'deck-showcase-japanese', -2, 5.1, 4, 'review'),
  ('card-showcase-03', 'deck-showcase-japanese', 1, 3.0, 6, 'review'),
  ('card-showcase-04', 'deck-showcase-japanese', 0, 0.5, 7, 'learning'),
  ('card-showcase-05', 'deck-showcase-japanese', 0, 0.0, 1, 'new'),
  ('card-showcase-06', 'deck-showcase-japanese', 0, 0.0, 1, 'new'),
  ('card-showcase-07', 'deck-showcase-japanese', 4, 8.2, 3, 'review'),
  ('card-showcase-08', 'deck-showcase-japanese', 0, 1.1, 8, 'relearning');

INSERT INTO reviews (id, card_id, grade, reviewed_at) VALUES
  ('review-showcase-01', 'card-showcase-01', 'Good', datetime('now', '-1 day')),
  ('review-showcase-02', 'card-showcase-02', 'Good', datetime('now', '-2 days')),
  ('review-showcase-03', 'card-showcase-04', 'Again', datetime('now', '-1 day')),
  ('review-showcase-04', 'card-showcase-07', 'Easy', datetime('now', '-3 days'));
