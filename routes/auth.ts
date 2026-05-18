import express, { Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import UserService, { DUMMY_PASSWORD_HASH } from '../models/User.js';
import { env } from '../config/env.js';
import {
  authLimiter,
  loginEmailLimiter,
  registerLimiter,
} from '../middleware/rateLimiter.js';
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
    const payload: JWTPayload = { sub: user.id };
    const token = jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: '24h',
      algorithm: 'HS256',
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });

    log.info({ userId: user.id, email: user.email }, 'User registered successfully');
    res.status(201).json({ token });
  }
);

router.post(
  '/login',
  authLimiter,
  loginEmailLimiter,
  validate(schemas.login),
  async (req, res: Response<AuthRouteResponse>): Promise<void> => {
    const { log, id: requestId } = req as RequestWithLogger;
    const { email, password } = req.body as LoginRequest;

    const user = await UserService.findByEmail(email);

    // Always run bcrypt — even when the user does not exist — to equalize
    // CPU work between the two branches. Without this, an attacker can
    // enumerate registered emails by measuring login response time
    // (~80ms hash vs near-instant DB miss). See security-audit-2026-05-18.md.
    const candidateHash = user?.password ?? DUMMY_PASSWORD_HASH;
    const isMatch = await UserService.comparePassword(password, candidateHash);

    if (!user || !isMatch) {
      // Both branches log the same shape — deliberately. Recording whether
      // the user existed (via `reason` or the presence of `userId`/`email`)
      // is the same enumeration oracle the dummy-hash flow above removes
      // for clients; the log line must not reintroduce it for log readers.
      log.warn(
        {
          ip: req.ip,
          userAgent: req.get('user-agent'),
        },
        'Login failed - invalid credentials',
      );
      const error = new InvalidCredentialsError();
      res.status(error.statusCode).json({ ...error.toJSON(), requestId });
      return;
    }

    // Opportunistic password rehash at the current SALT_ROUNDS for legacy
    // cost-10 (or lower) hashes. Fire-and-forget — must not block the
    // response. Failure is non-fatal: the next successful login retries.
    if (UserService.needsRehash(user.password)) {
      void UserService.updatePassword(user.id, password).catch((err: unknown) => {
        log.warn(
          { err, userId: user.id },
          'Password rehash failed, will retry on next login',
        );
      });
    }

    const payload: JWTPayload = { sub: user.id };
    const token = jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: '24h',
      algorithm: 'HS256',
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });

    log.info({ userId: user.id, email: user.email }, 'User logged in successfully');
    res.status(200).json({ token });
  }
);

export default router;
