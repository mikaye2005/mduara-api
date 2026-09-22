// Standalone tests should not require developer secrets or open Redis connections.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_SECRET ??= 'test-only-jwt-secret-never-use-in-production';
