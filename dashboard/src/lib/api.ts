import { headers } from 'next/headers';
import type { AccountContext } from './session';

const API_URL = process.env.INTERNAL_API_URL || process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const MASTER_KEY = process.env.MASTER_KEY || '';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';

/**
 * Every call below is server-to-server, so without this the worker would see
 * one IP — this container's — for the whole install and its per-IP rate limits
 * would apply to all customers at once.
 */
export async function clientIpHeaders(): Promise<Record<string, string>> {
  try {
    const incoming = await headers();
    const ip = incoming.get('x-forwarded-for') || incoming.get('x-real-ip');
    return ip ? { 'X-Forwarded-For': ip } : {};
  } catch {
    // Called outside a request scope; the worker falls back to the socket IP.
    return {};
  }
}

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      body.error || `Request failed with status ${res.status}`,
      res.status,
      body.code,
    );
  }
  return res.json();
}

/**
 * Server-to-server call carrying only the shared internal secret. Used for
 * endpoints that authenticate the caller themselves, i.e. login.
 */
export async function internalFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': INTERNAL_API_SECRET,
      ...(await clientIpHeaders()),
      ...options.headers,
    },
    cache: 'no-store',
  });
  return handleResponse<T>(res);
}

/**
 * Customer operation on behalf of a signed-in user, scoped to one account.
 * The worker re-checks the membership, so a forged account id in the browser
 * cannot widen access — these headers are a claim, not a grant.
 */
export async function accountFetch<T>(
  ctx: AccountContext,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': INTERNAL_API_SECRET,
      'X-User-Id': ctx.userId,
      'X-Account-Id': ctx.accountId,
      ...(await clientIpHeaders()),
      ...options.headers,
    },
    cache: 'no-store',
  });
  return handleResponse<T>(res);
}

export async function accountFormDataFetch<T>(
  ctx: AccountContext,
  path: string,
  body: FormData,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'X-Internal-Secret': INTERNAL_API_SECRET,
      'X-User-Id': ctx.userId,
      'X-Account-Id': ctx.accountId,
      ...(await clientIpHeaders()),
    },
    body,
    cache: 'no-store',
  });
  return handleResponse<T>(res);
}

/**
 * Raw streaming call (downloads/zips) for a signed-in user. Returns the
 * upstream Response so the caller can pipe the body through.
 */
export async function accountStreamFetch(
  ctx: AccountContext,
  path: string,
): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    headers: {
      'X-Internal-Secret': INTERNAL_API_SECRET,
      'X-User-Id': ctx.userId,
      'X-Account-Id': ctx.accountId,
      ...(await clientIpHeaders()),
    },
    cache: 'no-store',
  });
}

export async function publicFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(await clientIpHeaders()),
      ...options.headers,
    },
    cache: 'no-store',
  });
  return handleResponse<T>(res);
}

/**
 * MASTER_KEY call. Reaches every tenant, so it is reserved for system
 * administration (creating/listing accounts). Never reachable from a
 * customer-facing route.
 */
export async function systemAdminFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': MASTER_KEY,
      ...options.headers,
    },
    cache: 'no-store',
  });
  return handleResponse<T>(res);
}

export { ApiError };
