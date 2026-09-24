'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Canonical Phase 1 migration wrapper.
 *
 * The schema itself stays in 001_initial_schema.sql so there is exactly one
 * human-reviewable source of truth. node-pg-migrate is configured to execute
 * JavaScript migrations and ignore .sql files; this wrapper intentionally
 * bridges those two choices instead of duplicating schema definitions.
 */
exports.up = (pgm) => {
  const schemaPath = path.join(__dirname, '001_initial_schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  if (!sql.trim()) throw new Error(`Canonical schema is empty: ${schemaPath}`);
  pgm.sql(sql);
};

/**
 * Rolling back the initial schema would destroy all platform data. Refuse the
 * generic rollback command rather than pretending to reverse the migration or
 * dropping a shared schema implicitly. Destructive reset belongs in an explicit
 * development/test reset command with its own safety guard.
 */
exports.down = () => {
  throw new Error('001_initial_schema is intentionally irreversible; use an explicit database reset workflow for disposable environments');
};
