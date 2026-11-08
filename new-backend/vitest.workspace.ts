// One `vitest run` from new-backend/ runs every service suite with that
// service's own config (serial DB files, timeouts). Database-backed tests skip
// themselves when TEST_DATABASE_URL is unset.
export default ['services/*/vitest.config.ts'];
