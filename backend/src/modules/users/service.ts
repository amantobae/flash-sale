import { prisma } from '../../db';

export async function loginOrCreate(username: string) {
  return prisma.user.upsert({
    where: { username },
    create: { username, email: `${username}@example.test` },
    update: {},
  });
}
