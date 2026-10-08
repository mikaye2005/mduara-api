'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO chama_messages
      (chama_id, author_id, kind, body, created_at, updated_at)
    SELECT n.chama_id,
           (n.payload->>'createdBy')::uuid,
           'system',
           n.title || E'\n\n' || n.body,
           n.created_at,
           n.created_at
      FROM notifications n
     WHERE n.event_type = 'platform_admin_leadership_message'
       AND n.channel = 'in_app'
       AND n.chama_id IS NOT NULL
       AND n.payload ? 'createdBy'
       AND NOT (n.payload ? 'messageId')
     GROUP BY n.chama_id, n.payload->>'createdBy', n.title, n.body, n.created_at;

    UPDATE notifications n
       SET payload = n.payload || jsonb_build_object('messageId', (
             SELECT m.id
               FROM chama_messages m
              WHERE m.chama_id = n.chama_id
                AND m.author_id = (n.payload->>'createdBy')::uuid
                AND m.kind = 'system'
                AND m.body = n.title || E'\n\n' || n.body
                AND m.created_at = n.created_at
              ORDER BY m.id
              LIMIT 1
           )),
           status = 'sent',
           sent_at = COALESCE(n.sent_at, n.created_at)
     WHERE n.event_type = 'platform_admin_leadership_message'
       AND n.channel = 'in_app'
       AND n.payload ? 'createdBy'
       AND NOT (n.payload ? 'messageId');

    UPDATE notifications
       SET status = 'sent',
           sent_at = COALESCE(sent_at, created_at)
     WHERE event_type = 'platform_broadcast'
       AND channel = 'in_app'
       AND status = 'pending';
  `);
};

exports.down = () => {
  throw new Error('009_repair_admin_message_delivery is intentionally irreversible');
};
