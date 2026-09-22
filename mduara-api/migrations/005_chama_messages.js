'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE chama_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      chama_id UUID NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
      author_id UUID REFERENCES users(id) ON DELETE SET NULL,
      parent_message_id UUID REFERENCES chama_messages(id) ON DELETE SET NULL,
      kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'announcement', 'system')),
      body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_chama_messages_timeline
      ON chama_messages (chama_id, created_at DESC, id DESC);
    CREATE INDEX idx_chama_messages_replies
      ON chama_messages (parent_message_id, created_at ASC, id ASC)
      WHERE parent_message_id IS NOT NULL;
  `);
};

exports.down = () => {
  throw new Error('005_chama_messages is intentionally irreversible');
};