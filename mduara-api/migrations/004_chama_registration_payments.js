'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE chama_registration_payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      founder_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      chama_id UUID UNIQUE REFERENCES chamas(id) ON DELETE RESTRICT,
      creation_payload JSONB NOT NULL CHECK (jsonb_typeof(creation_payload) = 'object'),
      amount BIGINT NOT NULL CHECK (amount = 3000),
      currency TEXT NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
      phone_number TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'safaricom_daraja',
      merchant_request_id TEXT,
      checkout_request_id TEXT UNIQUE,
      receipt_number TEXT UNIQUE,
      status payment_status NOT NULL DEFAULT 'pending',
      result_code INTEGER,
      result_desc TEXT,
      request_payload JSONB,
      raw_payload JSONB,
      callback_verified_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_chama_registration_payments_founder_status
      ON chama_registration_payments (founder_id, status, created_at DESC);
  `);
};

exports.down = () => {
  throw new Error('004_chama_registration_payments is intentionally irreversible');
};