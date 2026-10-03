const DEFAULT_TEST_DATABASE_URL = 'postgresql://flash:flash@localhost:5433/flash_sale_test';

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against "${dbName}": TEST_DATABASE_URL must point at a database whose name ends with _test`,
    );
  }
  return url;
}
