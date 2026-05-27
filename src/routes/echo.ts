import express, { Request, Response, Router } from 'express';
import { env } from '../config/env.js';

const router: Router = express.Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'echo' });
});

// Honor the global BODY_LIMIT — express.json() without `limit` defaults to
// 100kb, which lets /echo accept payloads exceeding the configured cap.
router.post('/', express.json({ limit: env.BODY_LIMIT }), (req: Request, res: Response) => {
  res.json(req.body);
});

export default router;
