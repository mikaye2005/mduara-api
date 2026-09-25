'use strict';

exports.up = (pgm) => {
  pgm.addColumn('users', {
    must_change_password: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('users', 'must_change_password');
};
