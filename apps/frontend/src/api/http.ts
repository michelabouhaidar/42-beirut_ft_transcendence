// Every API module send its request through it.
export type ApiError = Error & { code?: string; status?: number; task?: unknown };

// https gets A 401 (revoked session).
// Realtime context gets session revoked from server & Authcontext signs the user out
// App.tsx (Route guards) sends them to /login?redirect=<this page>.
export const SESSION_EXPIRED_EVENT = "trenno:session-expired";
export const notifySessionExpired = () => window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));

type Options = { body?: unknown; signal?: AbortSignal };

async function request<T>(method: string, url: string, { body, signal }: Options = {}): Promise<T> {
	//checks if body is file (image) or raw binary data
	const isFile = body instanceof Blob;
  	const res = await fetch(url, {
    method,
    signal,
    headers: isFile ? { "Content-Type": body.type } : body !== undefined ? { "Content-Type": "application/json" } : { Accept: "application/json" },
    body: isFile ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) notifySessionExpired();
  // A refusal (wrong password, name taken, link used…) arrives as 200 with ok:false; pages handle it like an error.
  if (!res.ok || data?.ok === false) {
	const err = new Error(data?.error?.message || data?.message || `Request failed with status ${res.status}`) as ApiError;
    err.code = data?.error?.code;
    err.status = res.status;
    err.task = data?.task;
    throw err;
  }
  return data as T;
}

export const http = {
  get: <T>(url: string, signal?: AbortSignal) => request<T>("GET", url, { signal }),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, { body }),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, { body }),
  del: <T>(url: string, body?: unknown) => request<T>("DELETE", url, { body }),
};

export function query(params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : "";
}
