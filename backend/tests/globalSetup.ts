import { execSync } from 'node:child_process';
import { testDatabaseUrl } from './testDatabaseUrl';

export default function setup() {
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
  });
}
