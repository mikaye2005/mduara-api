/**
 * M-Duara uses PostgreSQL as its sole application persistence and auth
 * throttling store. Redis is intentionally not part of the Phase 1 runtime.
 * This compatibility module is kept empty so stale imports fail during review
 * instead of silently introducing a second state store.
 */
export {};
