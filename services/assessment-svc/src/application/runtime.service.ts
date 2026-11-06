import { Inject, Injectable } from '@nestjs/common';
import {
  type RunnerQuestion,
  type RunnerSession,
  type SaveResponseResult,
  SessionStarted,
} from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  ConflictError,
  DATABASE,
  type Database,
  DomainRuleError,
  newId,
  NotFoundError,
  RATE_LIMITER,
  type RateLimiter,
  randomToken,
  sha256,
  TooManyRequestsError,
  type Tx,
  UnauthorizedError,
  withSystemTx,
  withTenantTx,
} from '@atlas/platform';
import { type Assessment, buildPlan, planItems } from '../domain/assessment';
import { candidateView, type CodingPayload } from '../domain/questions';
import {
  assertTransition,
  ENDED,
  isExpired,
  LIVE,
  remainingSeconds,
  resume,
  SessionRuleError,
} from '../domain/session';
import { translate } from './access';
import { parseAnswer } from './schemas';
import { CodingDispatcher, submissionKey } from './coding-dispatch.service';
import { EvaluationService } from './evaluation.service';
import {
  ASSESSMENT_REPOSITORY,
  ASSESSMENT_SETTINGS,
  type AssessmentRepository,
  type AssessmentServiceSettings,
  INTERVIEW_GATEWAY,
  type InterviewGateway,
  INVITE_REPOSITORY,
  type InviteRepository,
  PROFILE_DIRECTORY,
  type ProfileDirectory,
  QUESTION_REPOSITORY,
  type QuestionRepository,
  type JudgeRef,
  PROCTORING_GATEWAY,
  type ProctoringGateway,
  RESPONSE_REPOSITORY,
  type ResponseRepository,
  SANDBOX_GATEWAY,
  type SandboxGateway,
  type Session,
  SESSION_REPOSITORY,
  type SessionRepository,
} from './ports';
import { toRunnerSession } from './views';

const DAY_MS = 24 * 3600 * 1000;

/**
 * The candidate runtime. Candidates authenticate with a session token (`Authorization: Session
 * ast_…`) that is bound to one session and stored only as a hash; it cannot read anything else.
 * The server clock is authoritative: every call re-checks the deadline.
 */
@Injectable()
export class RuntimeService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(INVITE_REPOSITORY) private readonly invites: InviteRepository,
    @Inject(ASSESSMENT_REPOSITORY) private readonly assessments: AssessmentRepository,
    @Inject(QUESTION_REPOSITORY) private readonly questions: QuestionRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(RESPONSE_REPOSITORY) private readonly responses: ResponseRepository,
    @Inject(PROFILE_DIRECTORY) private readonly profiles: ProfileDirectory,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ASSESSMENT_SETTINGS) private readonly settings: AssessmentServiceSettings,
    @Inject(SANDBOX_GATEWAY) private readonly sandbox: SandboxGateway,
    @Inject(PROCTORING_GATEWAY) private readonly proctoring: ProctoringGateway,
    @Inject(INTERVIEW_GATEWAY) private readonly interviews: InterviewGateway,
    private readonly evaluation: EvaluationService,
    private readonly dispatcher: CodingDispatcher,
  ) {}

  // --- Invites → sessions -----------------------------------------------------------------------

  async redeem(
    token: string,
    person: { full_name: string; email: string } | undefined,
  ): Promise<{
    session_id: string;
    session_token: string;
    assessment: { title: string; duration_seconds: number };
  }> {
    const invite = await withSystemTx(this.db, (tx) => this.invites.byTokenHash(tx, sha256(token)));
    const now = this.clock.now();
    if (!invite || invite.revokedAt || (invite.expiresAt && invite.expiresAt <= now)) {
      throw new NotFoundError('INVITE_NOT_FOUND', 'This invite link is not valid.');
    }
    let candidateId = invite.candidateId;
    if (invite.kind === 'open') {
      if (!person)
        throw new DomainRuleError('DETAILS_REQUIRED', 'Enter your name and email to start.');
      candidateId = await translate(() =>
        this.profiles.findOrCreate(
          invite.tenantId,
          { fullName: person.full_name, email: person.email },
          `invite:${invite.id}:${sha256(person.email.trim().toLowerCase()).toString('hex').slice(0, 32)}`,
        ),
      );
    }
    if (!candidateId) throw new NotFoundError('INVITE_NOT_FOUND', 'This invite link is not valid.');
    const sessionToken = `ast_${randomToken(32)}`;
    const id = newId();
    return translate(() =>
      withTenantTx(this.db, invite.tenantId, async (tx) => {
        const a = await this.assessments.get(tx, invite.assessmentId, invite.assessmentVersion);
        if (!a || a.status !== 'published')
          throw new DomainRuleError('ASSESSMENT_UNAVAILABLE', 'This assessment is closed.');
        const previous = await this.sessions.attempts(tx, a.id, candidateId);
        if (previous.some((s) => s.status === 'invited' || LIVE.includes(s.status))) {
          throw new ConflictError(
            'SESSION_EXISTS',
            'You already have an open attempt; use its link.',
          );
        }
        if (previous.length >= a.settings.max_attempts) {
          throw new DomainRuleError('MAX_ATTEMPTS', 'No attempts left for this assessment.');
        }
        const last = previous.at(-1);
        const lastEnd = last?.submittedAt ?? last?.invitedAt;
        if (
          lastEnd &&
          a.settings.retake_cooldown_days > 0 &&
          now.getTime() - lastEnd.getTime() < a.settings.retake_cooldown_days * DAY_MS
        ) {
          throw new DomainRuleError('RETAKE_COOLDOWN', 'A retake is not yet allowed.');
        }
        if (!(await this.invites.use(tx, invite.id))) {
          throw new ConflictError('INVITE_EXHAUSTED', 'This invite link has been used up.');
        }
        const plan = await this.plan(tx, a, id);
        const session: Session = {
          tenantId: invite.tenantId,
          id,
          assessmentId: a.id,
          assessmentVersion: a.version,
          candidateId,
          attemptNo: previous.length + 1,
          inviteId: invite.id,
          status: 'invited',
          plan,
          currentSection: 1,
          invitedAt: now,
          startedAt: null,
          deadlineAt: null,
          submittedAt: null,
          evaluatedAt: null,
          lastHeartbeatAt: null,
          pausedAt: null,
          pausedSeconds: 0,
          rawScore: null,
          maxScore: null,
          percentScore: null,
          performanceBand: null,
          skillScores: null,
          trustScore: null,
          reviewStatus: 'not_required',
          candidateStatus: 'pending',
          terminationReason: null,
          codingDispatchPending: false,
          lockVersion: 0,
        };
        await this.sessions.insert(tx, session, sha256(sessionToken));
        return {
          session_id: id,
          session_token: sessionToken,
          assessment: { title: a.candidateAlias ?? a.title, duration_seconds: a.durationSeconds },
        };
      }),
    );
  }

  private async plan(tx: Tx, a: Assessment, sessionId: string) {
    const fixed = a.definition.sections.flatMap((s) => s.questions);
    const questions = await this.questions.versions(
      tx,
      fixed.map((q) => ({ id: q.question_id, version: q.version ?? 0 })),
    );
    const banks = await this.questions.bankQuestions(
      tx,
      a.definition.sections.flatMap((s) => s.banks.map((b) => b.bank_id)),
    );
    return buildPlan(a, sessionId, questions, banks);
  }

  // --- Authentication ---------------------------------------------------------------------------------

  /** Resolves `Authorization: Session ast_…` to its session (and rate-limits per session). */
  async authenticate(sessionId: string, header: string | undefined): Promise<Session> {
    const match = /^Session\s+(ast_[A-Za-z0-9_-]{20,100})$/.exec(header?.trim() ?? '');
    if (!match?.[1])
      throw new UnauthorizedError('Send Authorization: Session <token>.', 'SESSION_TOKEN_REQUIRED');
    const session = await withSystemTx(this.db, (tx) =>
      this.sessions.byToken(tx, sessionId, sha256(match[1] as string)),
    );
    if (!session)
      throw new UnauthorizedError(
        'The session token is not valid for this session.',
        'SESSION_TOKEN_INVALID',
      );
    const endedAt =
      session.submittedAt ?? (ENDED.includes(session.status) ? session.deadlineAt : null);
    if (
      endedAt &&
      this.clock.now().getTime() > endedAt.getTime() + this.settings.tokenGraceSeconds * 1000
    ) {
      throw new UnauthorizedError('This session has ended.', 'SESSION_TOKEN_EXPIRED');
    }
    const decision = await this.limiter.consume(
      `assessment-session:${session.id}`,
      this.settings.sessionRateLimit,
      1,
    );
    if (!decision.allowed)
      throw new TooManyRequestsError('RATE_LIMITED', 'Too many requests.', decision.retryAfterSec);
    return session;
  }

  // --- Runtime ---------------------------------------------------------------------------------

  async state(s: Session): Promise<RunnerSession> {
    return translate(() =>
      withTenantTx(this.db, s.tenantId, async (tx) => {
        const live = LIVE.includes(s.status)
          ? (await this.touch(tx, s.id, { tolerateEnded: true })).session
          : s;
        return toRunnerSession(live, await this.assessment(tx, live), this.clock.now());
      }),
    );
  }

  async start(s: Session): Promise<RunnerSession> {
    return translate(() =>
      withTenantTx(this.db, s.tenantId, async (tx) => {
        const current = await this.load(tx, s.id);
        if (current.status !== 'invited') {
          if (LIVE.includes(current.status))
            return toRunnerSession(current, await this.assessment(tx, current), this.clock.now());
          throw new SessionRuleError('SESSION_ENDED', 'This session has ended.');
        }
        assertTransition(current.status, 'started');
        const a = await this.assessment(tx, current);
        const now = this.clock.now();
        const deadline = new Date(now.getTime() + a.durationSeconds * 1000);
        const started = await this.sessions.update(tx, s.id, current.lockVersion, {
          status: 'started',
          startedAt: now,
          deadlineAt: deadline,
          lastHeartbeatAt: now,
        });
        if (!started)
          throw new SessionRuleError('SESSION_CHANGED', 'The session changed; reload it.');
        await appendOutbox(
          tx,
          SessionStarted.build({
            tenantId: s.tenantId,
            aggregateId: s.id,
            payload: {
              tenant_id: s.tenantId,
              session_id: s.id,
              assessment_id: s.assessmentId,
              assessment_version: s.assessmentVersion,
              candidate_id: s.candidateId,
              attempt_no: s.attemptNo,
              deadline_at: deadline.toISOString(),
              occurred_at: now.toISOString(),
            },
          }),
        );
        return toRunnerSession(started, a, now);
      }),
    );
  }

  async question(s: Session, index: number): Promise<RunnerQuestion> {
    return this.whileLive(s, async (tx, current) => {
      let live = current;
      const a = await this.assessment(tx, live);
      const entry = planItems(live.plan).find((p) => p.index === index);
      if (!entry)
        throw new NotFoundError('QUESTION_NOT_FOUND', 'No such question in this session.');
      live = await this.enterSection(tx, live, a, entry.section);
      const q = (
        await this.questions.versions(tx, [
          { id: entry.item.question_id, version: entry.item.version },
        ])
      ).get(`${entry.item.question_id}@${entry.item.version}`);
      if (!q) throw new NotFoundError('QUESTION_NOT_FOUND', 'No such question in this session.');
      const saved = (await this.responses.all(tx, live.id)).get(q.id);
      return candidateView(
        q,
        entry.index,
        entry.section,
        entry.item.marks,
        saved ? { answer: saved.answer, clientRev: saved.clientRev } : null,
      );
    });
  }

  /** Autosave: accepted only before the deadline and only as the next `client_rev`. */
  async save(
    s: Session,
    questionId: string,
    clientRev: number,
    answer: unknown,
  ): Promise<SaveResponseResult> {
    return this.whileLive(s, async (tx, current) => {
      let live = current;
      const a = await this.assessment(tx, live);
      const entry = planItems(live.plan).find((p) => p.item.question_id === questionId);
      if (!entry)
        throw new NotFoundError('QUESTION_NOT_FOUND', 'No such question in this session.');
      live = await this.enterSection(tx, live, a, entry.section);
      const q = (
        await this.questions.versions(tx, [{ id: questionId, version: entry.item.version }])
      ).get(`${questionId}@${entry.item.version}`);
      if (!q) throw new NotFoundError('QUESTION_NOT_FOUND', 'No such question in this session.');
      if (q.type === 'ai_interview')
        throw new DomainRuleError(
          'ANSWER_NOT_EDITABLE',
          'AI interview answers are recorded by the interview itself.',
        );
      const parsed = parseAnswer(q.type, answer);
      const now = this.clock.now();
      if (
        !(await this.responses.save(tx, live.tenantId, live.id, questionId, clientRev, parsed, now))
      ) {
        const current = (await this.responses.all(tx, live.id)).get(questionId)?.clientRev ?? 0;
        throw new ConflictError('STALE_REVISION', `Expected client_rev ${current + 1}.`, {
          client_rev: current,
        });
      }
      if (live.status === 'started') {
        const moved = await this.sessions.update(tx, live.id, live.lockVersion, {
          status: 'in_progress',
        });
        if (moved) live = moved;
      }
      return {
        question_id: questionId,
        client_rev: clientRev,
        saved_at: now.toISOString(),
        remaining_seconds: remainingSeconds(live, now),
      };
    });
  }

  /** Candidate submit. After the deadline: 409 SESSION_EXPIRED (the expiry workflow submits). */
  async submit(s: Session): Promise<RunnerSession> {
    const view = await this.whileLive(s, async (tx, live) => {
      const ended = await this.evaluation.end(tx, live, 'submitted');
      return toRunnerSession(ended, await this.assessment(tx, ended), this.clock.now());
    });
    // Unsubmitted coding drafts go to the judge now; the sweeper retries if this fails.
    await this.dispatcher.dispatch(s.tenantId, s.id).catch(() => 0);
    return view;
  }

  // --- Proctoring (proctoring-svc, ADR-0007) ----------------------------------------------------

  /**
   * `POST /v1/sessions/{sid}:startProctoring`: after the pre-check, with the candidate's explicit
   * biometric consent. Returns the proctor token and HMAC session key for the SDK. Calling it again
   * (a page reload) resumes with a new key; the event chain continues.
   */
  async startProctoring(
    s: Session,
    consent: { biometrics: boolean; version: string },
  ): Promise<Record<string, unknown>> {
    return this.whileLive(s, async (tx, live) => {
      const a = await this.assessment(tx, live);
      const p = a.settings.proctoring;
      if (!p?.enabled)
        throw new DomainRuleError('PROCTORING_NOT_ENABLED', 'This assessment is not proctored.');
      return translate(() =>
        this.proctoring.start(live.tenantId, live.id, {
          assessment_id: live.assessmentId,
          candidate_id: live.candidateId,
          rules: p.rules,
          consent: { ...consent, granted_at: this.clock.now().toISOString() },
          id_verification: p.id_verification,
        }),
      );
    });
  }

  // --- AI interviews (interview-svc, ADR-0008) --------------------------------------------------

  /**
   * `POST /v1/sessions/{sid}/questions/{qid}:startInterview`: starts the AI interview (or, after a
   * reload, issues a new interview token for the same one). The answer records the interview
   * session; its score arrives with `interview.session.completed.v1`.
   */
  async startInterview(s: Session, questionId: string): Promise<Record<string, unknown>> {
    return this.whileLive(s, async (tx, current) => {
      const a = await this.assessment(tx, current);
      const entry = planItems(current.plan).find((p) => p.item.question_id === questionId);
      if (!entry)
        throw new NotFoundError('QUESTION_NOT_FOUND', 'No such question in this session.');
      const live = await this.enterSection(tx, current, a, entry.section);
      const q = (
        await this.questions.versions(tx, [{ id: questionId, version: entry.item.version }])
      ).get(`${questionId}@${entry.item.version}`);
      if (q?.type !== 'ai_interview')
        throw new DomainRuleError(
          'NOT_AN_INTERVIEW_QUESTION',
          'Only AI interview questions can be started.',
        );
      const { interview_id } = q.payload as { interview_id: string };
      const started = await translate(() =>
        this.interviews.start(live.tenantId, interview_id, {
          assessment_id: live.assessmentId,
          assessment_session_id: live.id,
          question_id: questionId,
          candidate_id: live.candidateId,
        }),
      );
      const saved = (await this.responses.all(tx, live.id)).get(questionId);
      const answer = { interview_session_id: started.session_id };
      if ((saved?.answer as typeof answer | null)?.interview_session_id !== started.session_id) {
        const rev = (saved?.clientRev ?? 0) + 1;
        await this.responses.save(
          tx,
          live.tenantId,
          live.id,
          questionId,
          rev,
          parseAnswer(q.type, answer),
          this.clock.now(),
        );
        if (live.status === 'started')
          await this.sessions.update(tx, live.id, live.lockVersion, { status: 'in_progress' });
      }
      return { ...started, remaining_seconds: remainingSeconds(live, this.clock.now()) };
    });
  }

  // --- Coding questions (sandbox-svc, ADR-0006) -------------------------------------------------

  /** Checks the question is a coding question of this session in a language it offers. */
  private async codingQuestion(
    tx: Tx,
    current: Session,
    questionId: string,
    language: string,
  ): Promise<{ live: Session; version: number }> {
    const a = await this.assessment(tx, current);
    const entry = planItems(current.plan).find((p) => p.item.question_id === questionId);
    if (!entry) throw new NotFoundError('QUESTION_NOT_FOUND', 'No such question in this session.');
    const live = await this.enterSection(tx, current, a, entry.section);
    const q = (
      await this.questions.versions(tx, [{ id: questionId, version: entry.item.version }])
    ).get(`${questionId}@${entry.item.version}`);
    if (q?.type !== 'coding')
      throw new DomainRuleError('NOT_A_CODING_QUESTION', 'Only coding questions can be run.');
    if (!(q.payload as unknown as CodingPayload).languages.includes(language))
      throw new DomainRuleError(
        'LANGUAGE_NOT_ALLOWED',
        `${language} is not offered for this question.`,
      );
    return { live, version: q.version };
  }

  private activeUntil(live: Session): string {
    const now = this.clock.now();
    return new Date(now.getTime() + (remainingSeconds(live, now) ?? 0) * 1000).toISOString();
  }

  /** Run against the sample tests or custom input (the judge throttles: 1 per 3 s). */
  async runCode(
    s: Session,
    questionId: string,
    input: { language: string; code: string; stdin?: string | null },
  ): Promise<{ run_id: string }> {
    return this.whileLive(s, async (tx, current) => {
      const { live, version } = await this.codingQuestion(tx, current, questionId, input.language);
      return translate(() =>
        this.sandbox.run(live.tenantId, live.id, questionId, {
          language: input.language,
          source: input.code,
          question_version: version,
          assessment_id: live.assessmentId,
          candidate_id: live.candidateId,
          active_until: this.activeUntil(live),
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        }),
      );
    });
  }

  async getRun(s: Session, runId: string, waitSeconds: number): Promise<Record<string, unknown>> {
    const run = await translate(() => this.sandbox.getRun(s.tenantId, runId, waitSeconds));
    if (run['session_id'] !== s.id) throw new NotFoundError('RUN_NOT_FOUND', 'No such run.');
    return run;
  }

  /**
   * Submit code for judging. The same code for the same question is one submission (also on
   * retries after a network drop); the latest submission's verdict counts.
   */
  async submitCode(
    s: Session,
    questionId: string,
    input: { language: string; code: string },
  ): Promise<{ submission_id: string; status: string }> {
    return this.whileLive(s, async (tx, current) => {
      const { live, version } = await this.codingQuestion(tx, current, questionId, input.language);
      const { submission_id } = await translate(() =>
        this.sandbox.submit(
          live.tenantId,
          live.id,
          questionId,
          {
            language: input.language,
            source: input.code,
            question_version: version,
            assessment_id: live.assessmentId,
            candidate_id: live.candidateId,
            active_until: this.activeUntil(live),
          },
          submissionKey(live.id, questionId, input.code),
        ),
      );
      const previous = (await this.responses.all(tx, live.id)).get(questionId)?.judge;
      if (previous?.submission_id !== submission_id) {
        const ref: JudgeRef = {
          submission_id,
          submitted_at: this.clock.now().toISOString(),
          status: 'queued',
        };
        await this.responses.ensure(tx, live.tenantId, live.id, questionId);
        await this.responses.setScore(tx, live.id, questionId, {
          autoScore: null,
          state: 'pending_judge',
          judge: ref,
        });
      }
      return { submission_id, status: 'queued' };
    });
  }

  async getSubmission(s: Session, submissionId: string): Promise<Record<string, unknown>> {
    const sub = await translate(() => this.sandbox.getSubmission(s.tenantId, submissionId));
    if (sub['session_id'] !== s.id)
      throw new NotFoundError('SUBMISSION_NOT_FOUND', 'No such submission.');
    return sub;
  }

  /**
   * Runs `work` on a live session. If the deadline has passed, the expiry (auto-submitting the
   * last acknowledged answers) is COMMITTED first and only then is 409 SESSION_EXPIRED raised:
   * throwing inside the transaction would roll the expiry back.
   */
  private async whileLive<T>(s: Session, work: (tx: Tx, live: Session) => Promise<T>): Promise<T> {
    const outcome = await translate(() =>
      withTenantTx(this.db, s.tenantId, async (tx) => {
        const { session, expiredNow } = await this.touch(tx, s.id);
        if (expiredNow) return { expired: true as const };
        return { expired: false as const, value: await work(tx, session) };
      }),
    );
    if (outcome.expired) {
      throw new ConflictError(
        'SESSION_EXPIRED',
        'The time for this session is over; your saved answers were submitted.',
      );
    }
    return outcome.value;
  }

  async heartbeat(s: Session): Promise<RunnerSession> {
    return this.state(s);
  }

  /**
   * The SSE feed: `state` on every status or section change, `time_warning` when the remaining
   * time crosses a threshold, `paused` / `resumed`, `terminated`, and `ended` (then the stream
   * closes). Read-only: watching never counts as a heartbeat.
   */
  async *events(s: Session): AsyncGenerator<{ event: string; data: unknown }> {
    let last: Session | null = null;
    const warned = new Set<number>();
    for (;;) {
      const current = await withTenantTx(this.db, s.tenantId, (tx) => this.sessions.get(tx, s.id));
      if (!current) return;
      const a = await withTenantTx(this.db, s.tenantId, (tx) => this.assessment(tx, current));
      const now = this.clock.now();
      const view = toRunnerSession(current, a, now);
      if (
        !last ||
        last.status !== current.status ||
        last.currentSection !== current.currentSection
      ) {
        if (last?.status !== 'paused' && current.status === 'paused')
          yield { event: 'paused', data: view };
        else if (last?.status === 'paused' && current.status === 'in_progress')
          yield { event: 'resumed', data: view };
        yield { event: 'state', data: view };
      }
      if (
        LIVE.includes(current.status) &&
        current.status !== 'paused' &&
        view.remaining_seconds !== null
      ) {
        for (const threshold of this.settings.warnings) {
          if (view.remaining_seconds <= threshold && !warned.has(threshold)) {
            warned.add(threshold);
            yield {
              event: 'time_warning',
              data: { remaining_seconds: view.remaining_seconds, threshold },
            };
          }
        }
      }
      // A terminated session is evaluated at once, so the stream may never see 'terminated'
      // itself: the termination reason is what tells the runner it was ended for it.
      if (ENDED.includes(current.status) && current.terminationReason) {
        yield { event: 'terminated', data: { reason: current.terminationReason } };
      }
      if (ENDED.includes(current.status) || current.status === 'cancelled') {
        yield { event: 'ended', data: { status: current.status } };
        return;
      }
      last = current;
      await new Promise((resolve) => setTimeout(resolve, this.settings.ssePollMs));
    }
  }

  /**
   * Re-checks the server clock and the pause rule for a live session: past the deadline it is
   * expired (409); after an interruption it resumes with the paused time credited back, up to the
   * allowance; otherwise the heartbeat is refreshed.
   */
  private async touch(
    tx: Tx,
    id: string,
    options: { tolerateEnded?: boolean } = {},
  ): Promise<{ session: Session; expiredNow: boolean }> {
    const s = await this.load(tx, id, true);
    if (s.status === 'invited')
      throw new SessionRuleError('SESSION_NOT_STARTED', 'Start the session first.');
    if (!LIVE.includes(s.status)) {
      if (options.tolerateEnded) return { session: s, expiredNow: false };
      throw new SessionRuleError(
        s.status === 'expired' ? 'SESSION_EXPIRED' : 'SESSION_ENDED',
        `This session is ${s.status}.`,
      );
    }
    const a = await this.assessment(tx, s);
    const now = this.clock.now();
    const allowance = a.settings.pause_allowance_seconds;
    if (isExpired(s, now, allowance)) {
      return { session: await this.evaluation.end(tx, s, 'expired'), expiredNow: true };
    }
    const change =
      s.status === 'paused'
        ? (() => {
            const r = resume(s, now, allowance);
            return {
              status: 'in_progress' as const,
              deadlineAt: r.deadlineAt,
              pausedAt: null,
              pausedSeconds: s.pausedSeconds + r.credited,
            };
          })()
        : {};
    const updated = await this.sessions.update(tx, s.id, s.lockVersion, {
      ...change,
      lastHeartbeatAt: now,
    });
    if (!updated)
      throw new SessionRuleError('SESSION_CHANGED', 'The session changed concurrently; retry.');
    return { session: updated, expiredNow: false };
  }

  /** Navigation: in fixed order, earlier sections are closed once a later one is opened. */
  private async enterSection(tx: Tx, s: Session, a: Assessment, section: number): Promise<Session> {
    if (section === s.currentSection) return s;
    if (a.navigation === 'fixed_section_order' && section < s.currentSection) {
      throw new SessionRuleError(
        'SECTION_LOCKED',
        'Earlier sections are closed in this assessment.',
      );
    }
    if (a.navigation === 'section_switch' && section < s.currentSection) return s;
    const moved = await this.sessions.update(tx, s.id, s.lockVersion, { currentSection: section });
    if (!moved)
      throw new SessionRuleError('SESSION_CHANGED', 'The session changed concurrently; retry.');
    return moved;
  }

  private async load(tx: Tx, id: string, forUpdate = false): Promise<Session> {
    const s = await this.sessions.get(tx, id, { forUpdate });
    if (!s) throw new NotFoundError('SESSION_NOT_FOUND', 'No such session.');
    return s;
  }

  private async assessment(tx: Tx, s: Session): Promise<Assessment> {
    const a = await this.assessments.get(tx, s.assessmentId, s.assessmentVersion);
    if (!a) throw new NotFoundError('ASSESSMENT_NOT_FOUND', 'No such assessment.');
    return a;
  }
}
