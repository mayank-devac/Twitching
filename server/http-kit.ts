// Shared plumbing for the control server's JSON routes: the host guard and error mapping.
import { timingSafeEqual } from "node:crypto";
import type express from "express";
import { z } from "zod";

export type HostCheck = (req: express.Request) => boolean;
// Builds a guard middleware that answers 403 with the given message before any body is parsed.
export type HostOnly = (message: string) => express.RequestHandler;

// The host must hold the httpOnly cookie and echo the same token in a header (double submit).
export function hostCheck(csrf: string, origin: string): HostCheck {
  return (req) => {
    const token = String(req.headers["x-host-token"] ?? "");
    const cookie = String(req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("arena_host="))
      ?.slice(11);
    if (
      cookie !== csrf ||
      token.length !== csrf.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))
    )
      return false;
    if (req.headers.origin) return req.headers.origin === origin;
    // Same-origin GET leaves Origin off. POST still has to send it.
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const site = req.headers["sec-fetch-site"];
    return !site || ["same-origin", "none"].includes(String(site));
  };
}

export const hostOnly =
  (authorized: HostCheck): HostOnly =>
  (message) =>
  (req, res, next) => {
    if (!authorized(req)) {
      respond(res, 403, { error: message });
      return;
    }
    next();
  };

export const respond = (res: express.Response, status: number, body: unknown) => {
  res.status(status).json(body);
};

// A deliberate client-facing failure: its status and message are always sent as-is.
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface RouteErrors {
  // Sent for anything not shown verbatim: non-Error throws and hidden Error messages.
  failed: string;
  // Sent for a ZodError; its raw message lists schema internals, so it is never shown.
  invalid?: string;
  // One status for every failure except HttpError. Omitted: ZodError 400, shown Error 409, otherwise 500.
  status?: number;
  // Which Error messages are written for the host and safe to show. Default: all of them.
  expose?: (error: Error) => boolean;
}

export function routeError(error: unknown, errors: RouteErrors): { status: number; message: string } {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (error instanceof z.ZodError) return { status: errors.status ?? 400, message: errors.invalid ?? errors.failed };
  if (error instanceof Error && (errors.expose?.(error) ?? true))
    return { status: errors.status ?? 409, message: error.message };
  return { status: errors.status ?? 500, message: errors.failed };
}

// Runs a handler and sends its result as JSON, or a mapped { error } on failure.
export const routeAction =
  (operation: (req: express.Request) => unknown, errors: RouteErrors) =>
  async (req: express.Request, res: express.Response) => {
    try {
      res.json(await operation(req));
    } catch (error) {
      const { status, message } = routeError(error, errors);
      respond(res, status, { error: message });
    }
  };
