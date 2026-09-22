'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    DELETE FROM member_merchant_rewards
    WHERE partnership_id IN (
      SELECT id FROM goal_merchant_partnerships WHERE is_demo = TRUE
    );

    DELETE FROM goal_merchant_partnerships WHERE is_demo = TRUE;
    DELETE FROM partner_merchants WHERE is_demo = TRUE;
  `);
};

exports.down = () => {
  throw new Error('002_remove_demo_data is intentionally irreversible');
};