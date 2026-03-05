const API_URL = process.env.INTERNAL_API_URL || process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const MASTER_KEY = process.env.MASTER_KEY || '';

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

export async function adminFetch<T>(
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

export async function publicFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    cache: 'no-store',
  });
  return handleResponse<T>(res);
}

export async function adminFormDataFetch<T>(
  path: string,
  body: FormData,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'X-API-Key': MASTER_KEY,
    },
    body,
    cache: 'no-store',
  });
  return handleResponse<T>(res);
}

export { ApiError };
