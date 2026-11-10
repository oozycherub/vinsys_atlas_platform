// In-memory stand-in for the gateway and the services behind it, for the Playwright suite. It
// follows the services' contracts (paths, bodies, RFC 9457 problems, token schemes) closely
// enough for the web app; the real services have their own acceptance tests.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 4010);
const TENANT = '0194f1b2-0000-7000-8000-00000000a001';
const id = () => randomUUID();
const token = (prefix = '') => prefix + randomBytes(24).toString('base64url');

const users = new Map([
  [
    'admin@acme.test',
    { user_id: id(), email: 'admin@acme.test', roles: ['tenant_admin'], status: 'active' },
  ],
]);
if (process.env.STUB_DEMO === '1') {
  users.set('recruiter@acme.test', {
    user_id: id(),
    email: 'recruiter@acme.test',
    roles: ['recruiter'],
    status: 'active',
  });
  users.set('employee@acme.test', {
    user_id: id(),
    email: 'employee@acme.test',
    roles: ['employee'],
    status: 'active',
  });
}
const WEB = process.env.STUB_WEB_ORIGIN ?? 'http://localhost:3100';
const outbox = []; // every "email" sent, newest first (the demo inbox page)
const mail = new Map(); // email -> { kind, token, binding? }
const magic = new Map(); // token -> { email, binding }
const invitations = new Map(); // token -> email
const questions = new Map();
const assessments = new Map();
const inviteLinks = new Map(); // token -> assessment_id
const sessions = new Map(); // session_id -> session
const sessionTokens = new Map(); // ast_ -> session_id
const reports = new Map();

function jwt(user) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none', typ: 'JWT' })}.${b({ sub: user.user_id, tid: TENANT, roles: user.roles, scopes: [], exp: Math.floor(Date.now() / 1000) + 3600 })}.stub`;
}
function claims(req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '');
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString());
  } catch {
    return null;
  }
}
function sessionOf(req) {
  const m = /^Session\s+(ast_\S+)$/.exec(req.headers.authorization ?? '');
  return m ? sessions.get(sessionTokens.get(m[1])) : null;
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
    ...headers,
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
const problem = (res, status, code, title) =>
  send(res, status, { type: 'about:blank', title, status, code });
const body = (req) =>
  new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s ? JSON.parse(s) : {}));
  });

function remaining(s) {
  return s.deadline ? Math.max(0, Math.round((s.deadline - Date.now()) / 1000)) : null;
}
function runnerView(s) {
  const a = assessments.get(s.assessment_id);
  return {
    session_id: s.session_id,
    status: s.status,
    title: a.title,
    navigation: 'section_switch',
    question_count: a.question_ids.length,
    sections: [{ index: 1, title: 'Coding', questions: a.question_ids.length }],
    current_section: 1,
    started_at: s.started_at,
    deadline_at: s.deadline ? new Date(s.deadline).toISOString() : null,
    server_time: new Date().toISOString(),
    remaining_seconds: remaining(s),
  };
}
function score(s) {
  const a = assessments.get(s.assessment_id);
  let got = 0;
  for (const qid of a.question_ids) {
    const q = questions.get(qid);
    const r = s.responses[qid];
    const t = q.payload.tests?.[0];
    if (r?.answer?.code && t && r.answer.code.includes('a + b')) got += 1;
  }
  return Math.round((got / a.question_ids.length) * 100);
}
const MINIMAL_PDF =
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

const routes = [
  // --- test helpers (not part of any contract) ---
  [
    'GET',
    /^\/__mailbox$/,
    (req, res, _m, url) => send(res, 200, mail.get(url.searchParams.get('email')) ?? {}),
  ],
  [
    'GET',
    /^\/__inbox$/,
    (req, res) => {
      const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      const rows = outbox
        .map(
          (m) =>
            `<li><strong>${esc(m.subject)}</strong> to ${esc(m.to)} <small>${esc(m.at.toISOString().slice(11, 19))} UTC</small><br><a href="${esc(m.link)}">Open the link</a></li>`,
        )
        .join('');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Demo inbox</title><style>body{font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem}li{margin:1rem 0}</style></head><body><h1>Demo inbox</h1><p>Emails the simulation would have sent. Click a link to sign in. Each link works once; use the newest one.</p><p><a href="${esc(WEB)}/login">Back to Atlas sign-in</a> · <a href="">Refresh</a></p><ul>${rows || '<li>No emails yet.</li>'}</ul></body></html>`,
      );
    },
  ],
  // --- identity ---
  [
    'POST',
    /^\/v1\/auth\/magic-links$/,
    async (req, res) => {
      const b = await body(req);
      const binding = token();
      if (users.has(b.email)) {
        const t = token();
        magic.set(t, { email: b.email, binding });
        mail.set(b.email, { kind: 'magic_link', token: t });
        outbox.unshift({
          to: b.email,
          subject: 'Your Atlas sign-in link',
          link: `${WEB}/auth/magic?token=${t}`,
          at: new Date(),
        });
      }
      send(res, 202, { binding, expires_in: 1800 });
    },
  ],
  [
    'POST',
    /^\/v1\/auth\/magic-links:redeem$/,
    async (req, res) => {
      const b = await body(req);
      const m = magic.get(b.token);
      // The demo skips the browser binding so a link works in any tab (identity-svc enforces it).
      if (!m || (process.env.STUB_DEMO !== '1' && m.binding !== b.binding))
        return problem(res, 401, 'INVALID_LINK', 'This link is not valid.');
      magic.delete(b.token);
      send(res, 200, {
        access_token: jwt(users.get(m.email)),
        token_type: 'Bearer',
        expires_in: 3600,
      });
    },
  ],
  [
    'POST',
    /^\/v1\/users:invite$/,
    async (req, res) => {
      if (!claims(req)?.roles.includes('tenant_admin'))
        return problem(res, 403, 'FORBIDDEN', 'Forbidden');
      const b = await body(req);
      const u = { user_id: id(), email: b.email, roles: b.roles, status: 'invited' };
      users.set(b.email, u);
      const t = token();
      invitations.set(t, b.email);
      mail.set(b.email, { kind: 'invitation', token: t });
      outbox.unshift({
        to: b.email,
        subject: 'You have been invited to Atlas',
        link: `${WEB}/invite?token=${t}`,
        at: new Date(),
      });
      send(res, 201, u);
    },
  ],
  ['GET', /^\/v1\/users$/, (req, res) => send(res, 200, { items: [...users.values()] })],
  [
    'POST',
    /^\/v1\/invitations:redeem$/,
    async (req, res) => {
      const b = await body(req);
      const email = invitations.get(b.token);
      if (!email) return problem(res, 401, 'INVALID_INVITATION', 'This invitation is not valid.');
      invitations.delete(b.token);
      const u = users.get(email);
      u.status = 'active';
      send(res, 200, { access_token: jwt(u), token_type: 'Bearer', expires_in: 3600 });
    },
  ],
  // --- assessment (staff) ---
  [
    'POST',
    /^\/v1\/questions$/,
    async (req, res) => {
      const b = await body(req);
      const q = { question_id: id(), version: 1, ...b };
      questions.set(q.question_id, q);
      send(res, 201, q);
    },
  ],
  [
    'POST',
    /^\/v1\/assessments$/,
    async (req, res) => {
      const b = await body(req);
      const a = {
        assessment_id: id(),
        title: b.title,
        status: 'draft',
        version: 1,
        duration_seconds: b.duration_seconds,
        question_ids: b.definition.sections.flatMap((s) => s.questions.map((q) => q.question_id)),
      };
      assessments.set(a.assessment_id, a);
      send(res, 201, a);
    },
  ],
  [
    'GET',
    /^\/v1\/assessments$/,
    (req, res) => send(res, 200, { items: [...assessments.values()] }),
  ],
  [
    'GET',
    /^\/v1\/assessments\/([^/:]+)$/,
    (req, res, m) =>
      assessments.has(m[1])
        ? send(res, 200, assessments.get(m[1]))
        : problem(res, 404, 'NOT_FOUND', 'Not found'),
  ],
  [
    'POST',
    /^\/v1\/assessments\/([^/:]+):publish$/,
    (req, res, m) => {
      const a = assessments.get(m[1]);
      a.status = 'published';
      send(res, 200, a);
    },
  ],
  [
    'POST',
    /^\/v1\/assessments\/([^/:]+)\/invite-links$/,
    (req, res, m) => {
      const t = token('inv_');
      inviteLinks.set(t, m[1]);
      send(res, 201, { invite_id: id(), token: t });
    },
  ],
  [
    'GET',
    /^\/v1\/assessments\/([^/:]+)\/sessions$/,
    (req, res, m) =>
      send(res, 200, {
        items: [...sessions.values()]
          .filter((s) => s.assessment_id === m[1])
          .map((s) => ({
            session_id: s.session_id,
            candidate_id: s.candidate_id,
            status: s.status,
            percent_score: s.status === 'submitted' ? score(s) : null,
            submitted_at: s.submitted_at,
          })),
      }),
  ],
  // --- candidate runner ---
  [
    'POST',
    /^\/v1\/invite-links\/([^/:]+):redeem$/,
    async (req, res, m) => {
      const aid = inviteLinks.get(m[1]);
      if (!aid) return problem(res, 404, 'INVITE_NOT_FOUND', 'This link is not valid.');
      const b = await body(req);
      const s = {
        session_id: id(),
        assessment_id: aid,
        candidate_id: id(),
        name: b.full_name,
        status: 'not_started',
        started_at: null,
        deadline: null,
        responses: {},
        submitted_at: null,
      };
      sessions.set(s.session_id, s);
      const t = token('ast_');
      sessionTokens.set(t, s.session_id);
      send(res, 201, {
        session_id: s.session_id,
        session_token: t,
        assessment: { title: assessments.get(aid).title },
      });
    },
  ],
  [
    'GET',
    /^\/v1\/sessions\/([^/:]+)$/,
    (req, res) => {
      const s = sessionOf(req);
      return s
        ? send(res, 200, runnerView(s))
        : problem(res, 401, 'UNAUTHENTICATED', 'Session token required');
    },
  ],
  [
    'POST',
    /^\/v1\/sessions\/([^/:]+):start$/,
    (req, res) => {
      const s = sessionOf(req);
      if (!s) return problem(res, 401, 'UNAUTHENTICATED', 'Session token required');
      if (!s.started_at) {
        s.started_at = new Date().toISOString();
        s.deadline = Date.now() + assessments.get(s.assessment_id).duration_seconds * 1000;
        s.status = 'in_progress';
      }
      send(res, 200, runnerView(s));
    },
  ],
  [
    'POST',
    /^\/v1\/sessions\/([^/:]+):startProctoring$/,
    (req, res) => problem(res, 409, 'PROCTORING_DISABLED', 'This assessment is not proctored.'),
  ],
  [
    'POST',
    /^\/v1\/sessions\/([^/:]+):heartbeat$/,
    (req, res) => {
      const s = sessionOf(req);
      return s
        ? send(res, 200, runnerView(s))
        : problem(res, 401, 'UNAUTHENTICATED', 'Session token required');
    },
  ],
  [
    'GET',
    /^\/v1\/sessions\/([^/:]+)\/questions\/(\d+)$/,
    (req, res, m) => {
      const s = sessionOf(req);
      if (!s) return problem(res, 401, 'UNAUTHENTICATED', 'Session token required');
      const qid = assessments.get(s.assessment_id).question_ids[Number(m[2]) - 1];
      const q = questions.get(qid);
      const r = s.responses[qid];
      send(res, 200, {
        index: Number(m[2]),
        section_index: 1,
        question_id: qid,
        type: q.type,
        prompt: q.prompt,
        marks: q.marks ?? 10,
        coding: { languages: q.payload.languages, starter_code: q.payload.starter_code },
        response: r?.answer ?? null,
        client_rev: r?.client_rev ?? 0,
      });
    },
  ],
  [
    'PUT',
    /^\/v1\/sessions\/([^/:]+)\/responses\/([^/:]+)$/,
    async (req, res, m) => {
      const s = sessionOf(req);
      if (!s) return problem(res, 401, 'UNAUTHENTICATED', 'Session token required');
      if (s.status !== 'in_progress')
        return problem(res, 409, 'SESSION_CLOSED', 'The session is closed.');
      const b = await body(req);
      const rev = s.responses[m[2]]?.client_rev ?? 0;
      if (b.client_rev !== rev + 1)
        return problem(res, 409, 'STALE_REVISION', 'A newer answer exists.');
      s.responses[m[2]] = { answer: b.answer, client_rev: b.client_rev };
      send(res, 200, {
        question_id: m[2],
        client_rev: b.client_rev,
        saved_at: new Date().toISOString(),
        remaining_seconds: remaining(s),
      });
    },
  ],
  [
    'POST',
    /^\/v1\/sessions\/([^/:]+)\/questions\/([^/:]+)\/runs$/,
    async (req, res) => {
      const b = await body(req);
      send(res, 200, {
        run_id: id(),
        status: 'completed',
        stdout: b.code.includes('a + b') ? '5\n' : '',
        stderr: '',
      });
    },
  ],
  [
    'POST',
    /^\/v1\/sessions\/([^/:]+):submit$/,
    (req, res) => {
      const s = sessionOf(req);
      if (!s) return problem(res, 401, 'UNAUTHENTICATED', 'Session token required');
      s.status = 'submitted';
      s.submitted_at = new Date().toISOString();
      send(res, 200, runnerView(s));
    },
  ],
  // --- reports ---
  [
    'POST',
    /^\/v1\/reports$/,
    async (req, res) => {
      const b = await body(req);
      const r = {
        report_id: id(),
        type: b.type,
        status: 'queued',
        params: b.params,
        polls: 0,
        error: null,
        download: null,
      };
      reports.set(r.report_id, r);
      send(res, 202, r);
    },
  ],
  [
    'GET',
    /^\/v1\/reports\/([^/:]+)$/,
    (req, res, m) => {
      const r = reports.get(m[1]);
      if (!r) return problem(res, 404, 'REPORT_NOT_FOUND', 'Not found');
      r.polls += 1;
      if (r.polls >= 1) {
        r.status = 'ready';
        r.download = {
          url: `/v1/report-artifacts/${r.report_id}:download?tenant_id=${TENANT}&exp=${Math.floor(Date.now() / 1000) + 900}&sig=stub`,
          file_name: 'assessment-report.pdf',
          content_type: 'application/pdf',
          size_bytes: MINIMAL_PDF.length,
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        };
      }
      send(res, 200, r);
    },
  ],
  [
    'GET',
    /^\/v1\/report-artifacts\/([^/:]+):download$/,
    (req, res) => {
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="assessment-report.pdf"',
      });
      res.end(MINIMAL_PDF);
    },
  ],
  [
    'GET',
    /^\/v1\/report-settings$/,
    (req, res) =>
      send(res, 200, {
        sections: [
          { key: 'summary', title: 'Summary', mandatory: true, enabled: true },
          { key: 'skill_scores', title: 'Skill scores', mandatory: true, enabled: true },
          { key: 'integrity', title: 'Integrity (Trust Score)', mandatory: false, enabled: true },
          {
            key: 'proctoring_evidence',
            title: 'Proctoring evidence',
            mandatory: false,
            enabled: false,
          },
          { key: 'ai_interview', title: 'AI interview', mandatory: false, enabled: true },
        ],
      }),
  ],
  // --- notifications ---
  [
    'GET',
    /^\/v1\/me\/notifications$/,
    (req, res) =>
      send(res, 200, {
        items: [
          {
            notification_id: id(),
            type: 'assessment_submitted',
            title: 'Assessment submitted',
            body: 'A candidate submitted.',
            path: null,
            read: false,
            created_at: new Date().toISOString(),
          },
        ],
        unread: 1,
        next_cursor: null,
      }),
  ],
  [
    'GET',
    /^\/v1\/me\/notifications:stream$/,
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: unread\ndata: {"unread":1}\n\n');
      const beat = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => clearInterval(beat));
    },
  ],
  ['POST', /^\/v1\/me\/notifications:markAllRead$/, (req, res) => send(res, 200, { marked: 1 })],
  [
    'GET',
    /^\/v1\/notification-preferences$/,
    (req, res) =>
      send(res, 200, {
        items: [
          { type: 'invitation', transactional: true, enabled: true, email: true, in_app: true },
          {
            type: 'assessment_submitted',
            transactional: false,
            enabled: true,
            email: true,
            in_app: true,
          },
        ],
      }),
  ],
  ['GET', /^\/v1\/webhook-endpoints$/, (req, res) => send(res, 200, { items: [] })],
  // --- taxonomy, intelligence, matching (read-only fixtures for the portals) ---
  [
    'GET',
    /^\/v1\/skills$/,
    (req, res) =>
      send(res, 200, {
        items: [{ skill_id: id(), name: 'Python', node_type: 'skill', path: 'tech.python' }],
      }),
  ],
  [
    'GET',
    /^\/v1\/job-profiles$/,
    (req, res) =>
      send(res, 200, {
        items: [{ job_profile_id: id(), title: 'Data Analyst', status: 'published' }],
      }),
  ],
  [
    'GET',
    /^\/v1\/analytics\/skill-gaps$/,
    (req, res) =>
      send(res, 200, {
        cells: [
          { group: 'Credit', skill_id: 'a1', skill_name: 'SQL', mean_gap: 0.6, employees: 5 },
          { group: 'Credit', skill_id: 'a2', skill_name: 'Python', mean_gap: 0.1, employees: 5 },
          { group: 'Risk', skill_id: 'a1', skill_name: 'SQL', mean_gap: 0.3, employees: 4 },
        ],
      }),
  ],
  [
    'GET',
    /^\/v1\/employees\/me$/,
    (req, res) =>
      send(res, 200, {
        employee_id: id(),
        department: 'Credit',
        location: 'Dubai',
        role_fit: {
          readiness: 0.72,
          band: 'medium',
          gaps: [{ skill_id: 'a1', skill_name: 'SQL', required: 4, proficiency: 3 }],
        },
      }),
  ],
  ['GET', /^\/v1\/employees\/([^/]+)\/career-paths$/, (req, res) => send(res, 200, { paths: [] })],
  [
    'GET',
    /^\/v1\/opportunities$/,
    (req, res) =>
      send(res, 200, {
        items: [
          {
            opportunity_id: id(),
            title: 'Data migration project',
            type: 'project',
            allocation_pct: 20,
            start_date: '2026-12-01',
            score: 0.81,
          },
        ],
      }),
  ],
  [
    'GET',
    /^\/v1\/job-requisitions$/,
    (req, res) =>
      send(res, 200, {
        items: [{ requisition_id: id(), title: 'Backend engineer', status: 'open', openings: 2 }],
      }),
  ],
];

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  for (const [method, pattern, handler] of routes) {
    const m = pattern.exec(url.pathname);
    if (m && method === req.method)
      return void Promise.resolve(handler(req, res, m, url)).catch((e) =>
        problem(res, 500, 'STUB_ERROR', String(e)),
      );
  }
  problem(res, 404, 'NOT_FOUND', `stub: no route for ${req.method} ${url.pathname}`);
}).listen(PORT, '127.0.0.1', () => console.log(`stub gateway on ${PORT}`));
