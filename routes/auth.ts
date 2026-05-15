import express, { Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import UserService from '../models/User.js';
import { env } from '../config/env.js';
import { authLimiter, registerLimiter } from '../middleware/rateLimiter.js';
import { validate, schemas } from '../middleware/validation.js';
import { InvalidCredentialsError } from '../errors/index.js';
import type {
  RegisterRequest,
  LoginRequest,
  AuthRouteResponse,
  JWTPayload,
  RequestWithLogger,
} from '../types/index.js';

const router: Router = express.Router();

router.post(
  '/register',
  registerLimiter,
  validate(schemas.register),
  async (req, res: Response<AuthRouteResponse>): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const { email, password } = req.body as RegisterRequest;

    const user = await UserService.create({ email, password });
    const payload: JWTPayload = { userId: user.id };
    const token = jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: '24h',
      algorithm: 'HS256',
    });

    log.info({ userId: user.id, email: user.email }, 'User registered successfully');
    res.status(201).json({ token });
  }
);

router.post(
  '/login',
  authLimiter,
  validate(schemas.login),
  async (req, res: Response<AuthRouteResponse>): Promise<void> => {
    const { log, id: requestId } = req as RequestWithLogger;
    const { email, password } = req.body as LoginRequest;

    const user = await UserService.findByEmail(email);

    if (!user) {
      log.warn(
        { email, ip: req.ip, userAgent: req.get('user-agent') },
        'Login failed - user not found'
      );
      const error = new InvalidCredentialsError();
      res.status(error.statusCode).json({ ...error.toJSON(), requestId });
      return;
    }

    const isMatch = await UserService.comparePassword(password, user.password);

    if (!isMatch) {
      log.warn(
        { email, userId: user.id, ip: req.ip, userAgent: req.get('user-agent') },
        'Login failed - incorrect password'
      );
      const error = new InvalidCredentialsError();
      res.status(error.statusCode).json({ ...error.toJSON(), requestId });
      return;
    }

    const payload: JWTPayload = { userId: user.id };
    const token = jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: '24h',
      algorithm: 'HS256',
    });

    log.info({ userId: user.id, email: user.email }, 'User logged in successfully');
    res.status(200).json({ token });
  }
);

export default router;
