import { prisma } from '../../src/db';

// Installs a trigger that raises at COMMIT, after the whole transaction callback has run.
export async function failCommitsOn(table: 'Reservation' | 'Payment') {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_fail_on_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced failure at commit';
    END
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE CONSTRAINT TRIGGER test_fail_on_commit AFTER INSERT ON "${table}"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_on_commit()
  `);
  return async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_on_commit ON "${table}"`);
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_on_commit()');
  };
}
