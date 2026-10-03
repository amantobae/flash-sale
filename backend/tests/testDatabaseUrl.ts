const DEFAULT_TEST_DATABASE_URL = 'postgresql://flash:flash@localhost:5433/flash_sale_test';

// Concurrency tests open ~20 interactive transactions at once; each holds a pooled connection.
const POOL_PARAMS: Record<string, string> = {
  connection_limit: '30',
  pool_timeout: '20',
};

export function testDatabaseUrl(): string {
  const url = new URL(process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against "${dbName}": TEST_DATABASE_URL must point at a database whose name ends with _test`,
    );
  }
  for (const [key, value] of Object.entries(POOL_PARAMS)) {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  return url.toString();
}
