import Joi, { Schema } from 'joi';
import type { Request, Response, NextFunction } from 'express';
import { ValidationError, InvalidIdFormatError } from '../errors/index.js';
import { normalizeEmail } from '../lib/normalizeEmail.js';

export const validate = (schema: Schema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const fields = error.details.map((detail) => ({
        field: detail.path.join('.'),
        message: detail.message,
      }));
      next(new ValidationError('Validation failed', { fields }));
      return;
    }

    req.body = value;
    next();
  };
};

export const validateQuery = (schema: Schema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.query, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const fields = error.details.map((detail) => ({
        field: detail.path.join('.'),
        message: detail.message,
      }));
      next(new ValidationError('Validation failed', { fields }));
      return;
    }

    Object.defineProperty(req, 'query', {
      value: value,
      writable: true,
      configurable: true,
    });
    next();
  };
};

// Validates route params (e.g. :id). A bad param yields InvalidIdFormatError
// (400 INVALID_ID_FORMAT) — the established contract for malformed resource IDs.
export const validateParams = (schema: Schema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error } = schema.validate(req.params, { abortEarly: false });

    if (error) {
      next(new InvalidIdFormatError());
      return;
    }

    next();
  };
};

// Canonical email schema. Delegates the NFC + lowercase + trim transform to the
// shared normalizeEmail helper so the validated request body, the per-email
// rate-limit bucket (middleware/rateLimiter.ts), and the stored blind index
// (models/User.ts) all key off the same bytes — denies Unicode-variant evasion
// (NFC vs NFD, full-width, homoglyph).
const emailSchema = Joi.string()
  .email()
  .trim()
  .custom((value: string) => normalizeEmail(value))
  .max(72);

// Password complexity rule, shared by registration and password change so the
// two never drift apart. `.required()` is applied per-use.
const passwordSchema = Joi.string()
  .min(8)
  .max(72)
  .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/)
  .messages({
    'string.pattern.base':
      'Password must contain uppercase, lowercase, number and special character',
  });

// Display name: trimmed, 1-100 chars (matches the users.name VARCHAR(100)).
const nameSchema = Joi.string().trim().min(1).max(100);

export const schemas = {
  register: Joi.object({
    email: emailSchema.required(),
    password: passwordSchema.required(),
  }),

  login: Joi.object({
    email: emailSchema.required(),
    password: Joi.string().required(),
  }),

  // Opaque refresh token (base64url, ~43 chars for 32 bytes). We only assert
  // presence + a sane length ceiling — the value's validity is decided by the
  // hash lookup, not by shape. The cap keeps an oversized body from reaching
  // the crypto hash.
  refresh: Joi.object({
    refreshToken: Joi.string().max(512).required(),
  }),

  logout: Joi.object({
    refreshToken: Joi.string().max(512).required(),
  }),

  // Profile update: display name only. Email lives on its own endpoint
  // (PATCH /user/me/email) so its re-auth check is unconditional — a security
  // check gated by request data trips static analysis (user-controlled bypass)
  // and reads as a bypass even though it isn't.
  updateProfile: Joi.object({
    name: nameSchema.required(),
  }),

  // Email change requires the current password (re-auth against account takeover
  // via a stolen access token). Both fields are always required, so the handler
  // verifies unconditionally.
  changeEmail: Joi.object({
    email: emailSchema.required(),
    currentPassword: Joi.string().required(),
  }),

  changePassword: Joi.object({
    currentPassword: Joi.string().required(),
    newPassword: passwordSchema.required(),
  }),

  deleteAccount: Joi.object({
    currentPassword: Joi.string().required(),
  }),

  // Admin role change. Domain mirrors the users_role_check DB constraint.
  updateRole: Joi.object({
    role: Joi.string().valid('user', 'admin').required(),
  }),

  todo: Joi.object({
    text: Joi.string().trim().min(1).max(500).required(),
  }),

  paramsSchema: Joi.object({
    id: Joi.string().uuid().required(),
  }),

  pagination: Joi.object({
    limit: Joi.number().integer().min(1).max(100).default(20),
    cursor: Joi.string().uuid().optional(),
  }),
};
