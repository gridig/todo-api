import Joi, { Schema } from 'joi';
import type { Request, Response, NextFunction } from 'express';
import { ValidationError, InvalidIdFormatError } from '../errors/index.js';

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

export const schemas = {
  register: Joi.object({
    email: Joi.string().email().trim().lowercase().max(72).required(),
    password: Joi.string()
      .min(8)
      .max(72)
      .pattern(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]+$/,
      )
      .required()
      .messages({
        'string.pattern.base':
          'Password must contain uppercase, lowercase, number and special character',
      }),
  }),

  login: Joi.object({
    email: Joi.string().email().trim().lowercase().required(),
    password: Joi.string().required(),
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
