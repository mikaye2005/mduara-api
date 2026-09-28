exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE chamas
      ALTER COLUMN public_join_code
      SET DEFAULT ('MD' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)));
  `);
};

exports.down = () => {
  throw new Error('008_chama_join_code_default is intentionally irreversible');
};
