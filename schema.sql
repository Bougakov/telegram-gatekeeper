-- One row per user who joined after the bot was installed.
-- status: pending  - in the group, muted, not yet answered
--         away     - unverified and out of the group (left or timed out); attempts carry over
--         verified - passed (or approved by an admin)
--         banned   - used up all attempts (or banned by an admin)
CREATE TABLE IF NOT EXISTS members (
  user_id       INTEGER PRIMARY KEY,
  status        TEXT    NOT NULL CHECK (status IN ('pending', 'away', 'verified', 'banned')),
  question_id   TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  prompt_msg_id INTEGER,
  dm_msg_ids    TEXT    NOT NULL DEFAULT '[]',
  joined_at     INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  name          TEXT,                         -- display name for admin notices
  admin_msgs    TEXT    NOT NULL DEFAULT '[]' -- admin notices to edit: [[chat_id, message_id], ...]
);

CREATE INDEX IF NOT EXISTS members_pending ON members (status, joined_at);

-- Webhook deduplication: Telegram re-delivers an update if it did not get a 200.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('last_update_id', 0);
