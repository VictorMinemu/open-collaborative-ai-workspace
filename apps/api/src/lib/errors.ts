/** Throw from handlers; the error handler maps it to `{ error: { code, message } }` with the status code. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "bad_request") => new HttpError(400, code, message);
export const unauthorized = (message = "Sign in required", code = "unauthorized") =>
  new HttpError(401, code, message);
export const forbidden = (message = "You do not have access to this resource", code = "forbidden") =>
  new HttpError(403, code, message);
export const notFound = (message = "Not found", code = "not_found") => new HttpError(404, code, message);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);
export const gone = (message: string, code = "gone") => new HttpError(410, code, message);
