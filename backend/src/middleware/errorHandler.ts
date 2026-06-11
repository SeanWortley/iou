import type { ErrorRequestHandler } from 'express';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status: number = (err as any).status ?? (err as any).statusCode ?? 500;
  const message: string = err instanceof Error ? err.message : 'Internal server error';
  console.error('[error]', err);
  res.status(status).json({ error: message });
};
