'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE commitment_payment_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      commitment_id UUID NOT NULL REFERENCES commitment_deposits(id) ON DELETE RESTRICT,
      membership_id UUID NOT NULL REFERENCES chama_members(id) ON DELETE RESTRICT,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      amount BIGINT NOT NULL CHECK (amount > 0),
      currency TEXT NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
      phone_number TEXT NOT NULL,
      merchant_request_id TEXT,
      checkout_request_id TEXT UNIQUE,
      receipt_number TEXT UNIQUE,
      status payment_status NOT NULL DEFAULT 'pending',
      result_code INTEGER,
      result_desc TEXT,
      request_payload JSONB,
      raw_payload JSONB,
      callback_verified_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX uq_commitment_payment_attempt_pending
      ON commitment_payment_attempts (commitment_id) WHERE status = 'pending';
  `);
};

exports.down = () => {
  throw new Error('007_commitment_payment_attempts is intentionally irreversible');
};