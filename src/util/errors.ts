export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string, id?: string) =>
  new AppError('NOT_FOUND', id ? `${what} ${id} not found` : `${what} not found`, 404);

export const conflict = (message: string, details?: unknown) => new AppError('CONFLICT', message, 409, details);

export const badRequest = (message: string, details?: unknown) => new AppError('BAD_REQUEST', message, 400, details);
