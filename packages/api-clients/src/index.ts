import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type * as Assessment from './generated/assessment-svc';
import type * as Identity from './generated/identity-svc';
import type * as Intelligence from './generated/intelligence-svc';
import type * as Interview from './generated/interview-svc';
import type * as Matching from './generated/matching-svc';
import type * as Notification from './generated/notification-svc';
import type * as Proctoring from './generated/proctoring-svc';
import type * as Profile from './generated/profile-svc';
import type * as Report from './generated/report-svc';
import type * as Taxonomy from './generated/taxonomy-svc';
import type * as Tenant from './generated/tenant-svc';

export type {
  Assessment,
  Identity,
  Intelligence,
  Interview,
  Matching,
  Notification,
  Proctoring,
  Profile,
  Report,
  Taxonomy,
  Tenant,
};

export interface AtlasClientOptions {
  /** The gateway origin (the UI never calls services directly). */
  baseUrl: string;
  /** Current access token, if signed in. */
  token?: () => string | null | undefined;
  fetch?: typeof fetch;
  /** Called with every problem response (RFC 9457), e.g. to sign out on 401. */
  onProblem?: (status: number, code: string | undefined, requestId: string | null) => void;
}

/** RFC 9457 problem document, as every Atlas service returns errors. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code?: string;
  detail?: string;
  request_id?: string;
  errors?: { path: string; message: string }[];
}

export function isProblem(value: unknown): value is Problem {
  return typeof value === 'object' && value !== null && 'status' in value && 'title' in value;
}

function middleware(o: AtlasClientOptions): Middleware {
  return {
    onRequest({ request }) {
      const token = o.token?.();
      if (token && !request.headers.has('Authorization'))
        request.headers.set('Authorization', `Bearer ${token}`);
      return request;
    },
    async onResponse({ response }) {
      if (!response.ok && o.onProblem) {
        const body = (await response
          .clone()
          .json()
          .catch(() => null)) as Problem | null;
        o.onProblem(response.status, body?.code, response.headers.get('x-request-id'));
      }
      return response;
    },
  };
}

export interface AtlasClients {
  tenant: Client<Tenant.paths>;
  identity: Client<Identity.paths>;
  taxonomy: Client<Taxonomy.paths>;
  profile: Client<Profile.paths>;
  matching: Client<Matching.paths>;
  assessment: Client<Assessment.paths>;
  proctoring: Client<Proctoring.paths>;
  interview: Client<Interview.paths>;
  intelligence: Client<Intelligence.paths>;
  notification: Client<Notification.paths>;
  report: Client<Report.paths>;
}

/** One typed client per service, all pointed at the gateway with the same auth middleware. */
export function createAtlasClients(o: AtlasClientOptions): AtlasClients {
  const make = <P extends object>(): Client<P> => {
    const c = createClient<P>({
      baseUrl: o.baseUrl.replace(/\/$/, ''),
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    c.use(middleware(o));
    return c;
  };
  return {
    tenant: make<Tenant.paths>(),
    identity: make<Identity.paths>(),
    taxonomy: make<Taxonomy.paths>(),
    profile: make<Profile.paths>(),
    matching: make<Matching.paths>(),
    assessment: make<Assessment.paths>(),
    proctoring: make<Proctoring.paths>(),
    interview: make<Interview.paths>(),
    intelligence: make<Intelligence.paths>(),
    notification: make<Notification.paths>(),
    report: make<Report.paths>(),
  };
}
