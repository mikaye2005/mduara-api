if (!process.env.TEST_DATABASE_URL?.trim()) {
  throw new Error('TEST_DATABASE_URL is required for release integration verification; refusing to report success with PostgreSQL suites skipped');
}