'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE chamas ADD COLUMN public_join_code TEXT;
    UPDATE chamas
       SET public_join_code = 'MD' || upper(replace(substr(id::text, 1, 8), '-', ''))
     WHERE public_join_code IS NULL;
    ALTER TABLE chamas ALTER COLUMN public_join_code SET NOT NULL;
    ALTER TABLE chamas ADD CONSTRAINT uq_chamas_public_join_code UNIQUE (public_join_code);
    ALTER TABLE chamas ADD CONSTRAINT chk_chamas_public_join_code
      CHECK (public_join_code ~ '^MD[A-Z0-9]{8}$');
  `);
};

exports.down = () => {
  throw new Error('006_chama_public_join_codes is intentionally irreversible');
};