import { Response } from "express";

// A valid request the current state refuses (wrong password, name taken, link used,
// edited by someone else) is an answer, not an error: 200 with ok:false.
export function refuse(res: Response, code: string, message: string, extra: object = {}) {
  return res.status(200).json({ ok: false, error: { code, message }, ...extra });
}

// Thrown errors with these statuses go out through refuse(): not (or no longer) allowed or there
// (403, 404 — usually someone else's action, a stale link or bookmark), the state says no (409 conflict,
// 410 gone, 423 locked, 429 too many) or the content was rejected (413 too large, 415 wrong type, 422 invalid).
const REFUSALS = new Set([403, 404, 409, 410, 413, 415, 422, 423, 429]);
export const isRefusal = (status: number) => REFUSALS.has(status);
