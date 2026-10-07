-- Keep each Review's resulting schedule beside its before-grade snapshot.
-- Older events remain visible, but their after-state is left unknown rather
-- than inferred from a later grade or today's Card state.

ALTER TABLE reviews ADD COLUMN state_after TEXT;
ALTER TABLE reviews ADD COLUMN stability_after REAL;
ALTER TABLE reviews ADD COLUMN difficulty_after REAL;
ALTER TABLE reviews ADD COLUMN due_in_days_after INTEGER;
ALTER TABLE reviews ADD COLUMN due_at_after TEXT;
