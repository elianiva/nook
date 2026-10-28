-- Story generations per user per UTC day. The Worker pays for every generation
-- with one shared provider key, so each user gets a daily allowance
-- (`STORY_DAILY_LIMIT` in `src/stories.ts`) instead of the whole key.

CREATE TABLE story_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
