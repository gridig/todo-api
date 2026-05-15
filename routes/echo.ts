import express, { Request, Response, Router } from 'express';

const router: Router = express.Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'echo' });
});

router.post('/', express.json(), (req: Request, res: Response) => {
  res.json(req.body);
});

export default router;
