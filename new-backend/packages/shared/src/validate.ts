/**
 * zod validation middleware.
 *
 * Parsed output lands on `req.valid.{body,query,params}` and is read back with
 * the typed `validated…` accessors. Nothing writes back to `req.query` or
 * `req.params` — in Express 5 those are getters, and overwriting a request's
 * own view of its input is how "validated" and "used" drift apart.
 *
 * Schemas are strict by default via `strictBody`: an unexpected key is a 400,
 * not a silently ignored field. That matters because the old server accepted
 * `{ name, wallet, playerID }` in bodies and trusted them.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { AppError } from './errors.js';
import { CHAIN_SLUGS } from './chains.js';

interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code?: string;
}

/**
 * Turn zod issues into client-safe details: field path, message and code only.
 * The offending *value* is never echoed back.
 */
function issueDetails(issues: readonly IssueLike[]): Array<{ path: string; message: string; code?: string }> {
  return issues.slice(0, 25).map((issue) => {
    const entry: { path: string; message: string; code?: string } = {
      path: issue.path.map(String).join('.'),
      message: issue.message,
    };
    if (issue.code) entry.code = issue.code;
    return entry;
  });
}

function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown, where: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw AppError.badRequest(`Invalid request ${where}`, { issues: issueDetails(result.error.issues) });
  }
  return result.data;
}

function ensureValid(req: Request): NonNullable<Request['valid']> {
  if (!req.valid) req.valid = {};
  return req.valid;
}

/** Validate and replace `req.body`; also stored on `req.valid.body`. */
export function validateBody<T extends z.ZodType>(schema: T): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const parsed = parseOrThrow(schema, req.body ?? {}, 'body');
      ensureValid(req).body = parsed;
      req.body = parsed;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Validate `req.query` into `req.valid.query` (does not mutate `req.query`). */
export function validateQuery<T extends z.ZodType>(schema: T): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      ensureValid(req).query = parseOrThrow(schema, req.query ?? {}, 'query');
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Validate `req.params` into `req.valid.params` (does not mutate `req.params`). */
export function validateParams<T extends z.ZodType>(schema: T): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      ensureValid(req).params = parseOrThrow(schema, req.params ?? {}, 'path parameters');
      next();
    } catch (err) {
      next(err);
    }
  };
}

/* Typed accessors — call with the same schema you validated with. */

export function validatedBody<T extends z.ZodType>(req: Request, _schema?: T): z.infer<T> {
  return req.valid?.body as z.infer<T>;
}
export function validatedQuery<T extends z.ZodType>(req: Request, _schema?: T): z.infer<T> {
  return req.valid?.query as z.infer<T>;
}
export function validatedParams<T extends z.ZodType>(req: Request, _schema?: T): z.infer<T> {
  return req.valid?.params as z.infer<T>;
}

/**
 * Build a strict object schema — unknown keys are rejected rather than dropped.
 * Use for every request body.
 */
export function strictBody<S extends z.ZodRawShape>(shape: S) {
  return z.strictObject(shape);
}

/* -------------------------------------------------------------------------- */
/* Reusable field schemas                                                     */
/* -------------------------------------------------------------------------- */

export const zChain = z.enum(CHAIN_SLUGS as [string, ...string[]]);

export const zEvmAddress = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address');

export const zBase58 = z
  .string()
  .trim()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a base58 address');

/** Either address form; the chain decides which is legal (see `normalizeAddress`). */
export const zAddress = z.union([zEvmAddress, zBase58]);

export const zUuid = z.string().uuid();

/** A postgres `bigserial` id arriving as a string. */
export const zBigIntString = z
  .string()
  .regex(/^[0-9]{1,19}$/, 'must be a positive integer id');

/** Accepts a number or numeric string, yields a bigint-safe string. */
export const zIdParam = z.union([zBigIntString, z.number().int().positive().transform(String)]);

/** Opaque tokens: base64url, bounded so a huge body cannot reach crypto code. */
export const zOpaqueToken = z
  .string()
  .trim()
  .min(16)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be a base64url token');

/** A signature: base58 (Solana) or 0x-hex (EVM), length-bounded. */
export const zSignature = z
  .string()
  .trim()
  .min(16)
  .max(512)
  .regex(/^(0x[0-9a-fA-F]+|[1-9A-HJ-NP-Za-km-z]+)$/, 'must be a hex or base58 signature');

export const zDisplayName = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.\-…]*$/u, 'letters, numbers, space, _ . - only');

/** Standard pagination. */
export const zPagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export { z };
