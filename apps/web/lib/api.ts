'use client';

import { createAtlasClients, isProblem, type Problem } from '@atlas/api-clients';
import { clearSession, loadSession } from './session';

/** Typed clients for every service, through the gateway (same origin). */
export const api = createAtlasClients({
  baseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  token: () => loadSession()?.accessToken,
  onProblem: (status) => {
    if (status === 401 && typeof window !== 'undefined' && loadSession()) {
      clearSession();
      window.location.assign('/login');
    }
  },
});

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
  }
}

/** Unwraps an openapi-fetch result: the data, or an ApiError with the problem document. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    const p = isProblem(result.error)
      ? result.error
      : { type: 'about:blank', title: 'Request failed', status: result.response.status };
    throw new ApiError(p);
  }
  return result.data as T;
}
