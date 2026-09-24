'use strict';

const fixtureChamaIds = [
  '41000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000002',
  '41000000-0000-4000-8000-000000000003',
  '41000000-0000-4000-8000-000000000004',
];

exports.up = (pgm) => {
  pgm.sql(`
    DELETE FROM chama_members
    WHERE chama_id = ANY(ARRAY[${fixtureChamaIds.map((id) => `'${id}'`).join(', ')}]::uuid[]);

    DELETE FROM chamas
    WHERE id = ANY(ARRAY[${fixtureChamaIds.map((id) => `'${id}'`).join(', ')}]::uuid[]);

    DELETE FROM users
    WHERE email LIKE '%.dev@mduara.test';
  `);
};

exports.down = () => {
  throw new Error('003_remove_development_fixtures is intentionally irreversible');
};