-- Per-deck scheduling limits, overriding the global defaults.
--
-- Each column is NULL for "use the global setting": a new Deck and every Deck
-- imported before this migration behave exactly as before. The queue resolves
-- the effective value per Deck as `override ?? global`, so a blank field in
-- the deck page means "follow Settings".
--
-- `new_per_day` caps how many new Cards enter review per learner-day,
-- `reviews_per_day` caps how many review Cards are due per learner-day, and
-- `lapse_minutes` sets how long an `Again` Card waits before it re-queues in
-- the same session. All three mirror the global knobs in `settings`.

ALTER TABLE decks ADD COLUMN new_per_day INTEGER;
ALTER TABLE decks ADD COLUMN reviews_per_day INTEGER;
ALTER TABLE decks ADD COLUMN lapse_minutes INTEGER;
