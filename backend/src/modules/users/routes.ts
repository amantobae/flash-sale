import { Router } from 'express';
import { z } from 'zod';
import { parseOrThrow } from '../../validation';
import { loginOrCreate } from './service';

const loginBody = z.object({
  username: z.string().trim().min(1).max(50),
});

export function userRoutes() {
  const router = Router();

  router.post('/api/users/login', async (req, res) => {
    const { username } = parseOrThrow(loginBody, req.body);
    const user = await loginOrCreate(username);
    res.json({ user: { id: user.id, username: user.username, email: user.email, role: user.role } });
  });

  return router;
}
