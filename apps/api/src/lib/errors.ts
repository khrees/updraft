import type { Context } from 'hono';
import { ZodError } from 'zod';
import { DeploymentNotFoundError } from '../db/repository.js';

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export function handleError(c: Context, err: unknown): Response {
  if (err instanceof ZodError) {
    const flat = err.flatten();
    const details = Object.keys(flat.fieldErrors).length
      ? flat.fieldErrors
      : flat.formErrors;
    return c.json({ success: false, message: 'Validation error', data: details }, 400);
  }
  if (err instanceof BadRequestError) {
    return c.json({ success: false, message: err.message, data: null }, 400);
  }
  if (err instanceof DeploymentNotFoundError) {
    return c.json({ success: false, message: err.message, data: null }, 404);
  }
  console.error(err);
  return c.json({ success: false, message: 'Internal server error', data: null }, 500);
}
