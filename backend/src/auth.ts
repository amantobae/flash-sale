import type { RequestHandler, Response } from 'express';
import type { User } from '@prisma/client';
import { prisma } from './db';
import { AppError } from './errors';

export const requireUser: RequestHandler = async (req, res, next) => {
  const header = req.header('X-User-Id');
  const userId = header && /^\d+$/.test(header) ? Number(header) : NaN;
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new AppError(401, 'UNAUTHORIZED', 'X-User-Id header is missing or invalid');
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(401, 'UNAUTHORIZED', 'User does not exist');
  }
  res.locals.user = user;
  next();
};

export function currentUser(res: Response): User {
  return res.locals.user as User;
}
