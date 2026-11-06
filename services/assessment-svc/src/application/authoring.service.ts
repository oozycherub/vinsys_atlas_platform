import { Inject, Injectable } from '@nestjs/common';
import { AssessmentPublished } from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  DomainRuleError,
  newId,
  NotFoundError,
  PreconditionFailedError,
  type Principal,
  randomToken,
  sha256,
  type Tx,
  withTenantTx,
} from '@atlas/platform';
import {
  type Assessment,
  type AssessmentKind,
  type Definition,
  type Navigation,
  pinDefinition,
  type ReportConfig,
  type Settings,
} from '../domain/assessment';
import { type CodingPayload, type Question, type QuestionType } from '../domain/questions';
import { definitionSchema, parsePayload, reportConfigSchema, settingsSchema } from './schemas';
import { tenantOf, translate } from './access';
import { type Logger } from 'pino';
import {
  ASSESSMENT_LOGGER,
  ASSESSMENT_REPOSITORY,
  ASSESSMENT_SETTINGS,
  type AssessmentRepository,
  type AssessmentServiceSettings,
  type Bank,
  type Invite,
  INVITE_REPOSITORY,
  type InviteRepository,
  QUESTION_REPOSITORY,
  type QuestionRepository,
  SANDBOX_GATEWAY,
  type SandboxBundle,
  type SandboxGateway,
} from './ports';
import {
  type AssessmentView,
  type QuestionAuthorView,
  toAssessmentView,
  toBankView,
  toInviteView,
  toQuestionAuthorView,
} from './views';

export interface QuestionInput {
  bank_id: string | null;
  type: QuestionType;
  prompt: string;
  payload?: unknown;
  marks: number;
  negative_marks: number;
  difficulty: Question['difficulty'];
  skill_ids: string[];
}

export interface AssessmentInput {
  title: string;
  candidate_alias: string | null;
  kind: AssessmentKind;
  navigation: Navigation;
  duration_seconds: number;
  definition?: unknown;
  settings?: unknown;
  report_config?: unknown;
  job_profile_id: string | null;
}

/** Question bank and assessment authoring (recruiters, SMEs), publishing and invite links. */
@Injectable()
export class AuthoringService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(QUESTION_REPOSITORY) private readonly questions: QuestionRepository,
    @Inject(ASSESSMENT_REPOSITORY) private readonly assessments: AssessmentRepository,
    @Inject(INVITE_REPOSITORY) private readonly invites: InviteRepository,
    @Inject(ASSESSMENT_SETTINGS) private readonly settings: AssessmentServiceSettings,
    @Inject(SANDBOX_GATEWAY) private readonly sandbox: SandboxGateway,
    @Inject(ASSESSMENT_LOGGER) private readonly logger: Logger | null,
  ) {}

  // --- Coding questions (sandbox-svc, ADR-0006) -------------------------------------------------

  /** Starts verification early; publish registers again (idempotent) and waits for the result. */
  private registerSoon(q: Question): void {
    const bundle = bundleOf(q);
    if (!bundle) return;
    this.sandbox.registerBundle(q.tenantId, q.id, q.version, bundle).catch((error: unknown) => {
      this.logger?.warn({ err: error, question_id: q.id }, 'coding test registration failed');
    });
  }

  /**
   * The publish gate: every coding question the assessment can serve (fixed ones and those in
   * its banks) needs test cases that sandbox-svc has verified with the reference solution.
   */
  private async checkCodingQuestions(questions: Question[]): Promise<string[]> {
    const coding = questions.filter((q) => q.type === 'coding');
    const languages = new Set<string>();
    const pending: string[] = [];
    const invalid: string[] = [];
    for (const q of coding) {
      const bundle = bundleOf(q);
      if (!bundle) {
        throw new DomainRuleError(
          'REFERENCE_SOLUTION_REQUIRED',
          `Coding question ${q.id}@${q.version} needs a reference solution before it can be published.`,
        );
      }
      bundle.languages.forEach((l) => languages.add(l));
      const verdict = await this.sandbox.registerBundle(q.tenantId, q.id, q.version, bundle);
      if (verdict.status === 'pending') pending.push(`${q.id}@${q.version}`);
      else if (verdict.status !== 'verified')
        invalid.push(`${q.id}@${q.version}: ${verdict.status} (${verdict.status_detail ?? ''})`);
    }
    if (invalid.length)
      throw new DomainRuleError(
        'CODING_TESTS_INVALID',
        `The reference solution failed or its results differed between runs: ${invalid.join('; ')}.`,
      );
    if (pending.length)
      throw new DomainRuleError(
        'CODING_TESTS_PENDING',
        `Test cases are still being verified for ${pending.join(', ')}; try again in a minute.`,
      );
    return [...languages].sort();
  }

  // --- Question bank ----------------------------------------------------------------------------

  async createBank(
    p: Principal,
    tenant: string | undefined,
    input: { name: string; description: string; skill_ids: string[] },
  ) {
    const tenantId = tenantOf(p, tenant);
    const bank: Bank = {
      tenantId,
      id: newId(),
      name: input.name,
      description: input.description,
      skillIds: input.skill_ids,
      createdBy: p.subject,
      createdAt: this.clock.now(),
    };
    await withTenantTx(this.db, tenantId, (tx) => this.questions.insertBank(tx, bank));
    return toBankView(bank);
  }

  async createQuestion(
    p: Principal,
    tenant: string | undefined,
    input: QuestionInput,
  ): Promise<QuestionAuthorView> {
    const tenantId = tenantOf(p, tenant);
    return translate(() =>
      withTenantTx(this.db, tenantId, async (tx) => {
        if (input.bank_id && !(await this.questions.bank(tx, input.bank_id))) {
          throw new NotFoundError('BANK_NOT_FOUND', 'No such question bank.');
        }
        const q = this.buildQuestion(tenantId, newId(), 1, input, p.subject);
        await this.questions.insert(tx, q);
        return q;
      }),
    ).then((q) => {
      this.registerSoon(q);
      return toQuestionAuthorView(q, null);
    });
  }

  /** Questions are immutable per version: editing creates version n+1. */
  async reviseQuestion(
    p: Principal,
    tenant: string | undefined,
    id: string,
    input: QuestionInput,
  ): Promise<QuestionAuthorView> {
    const tenantId = tenantOf(p, tenant);
    return translate(() =>
      withTenantTx(this.db, tenantId, async (tx) => {
        const current = await this.questions.get(tx, id);
        if (!current) throw new NotFoundError('QUESTION_NOT_FOUND', 'No such question.');
        if (current.type !== input.type)
          throw new DomainRuleError('TYPE_IMMUTABLE', 'A question cannot change type.');
        const q = this.buildQuestion(tenantId, id, current.version + 1, input, p.subject);
        await this.questions.insert(tx, q);
        return q;
      }),
    ).then((q) => {
      this.registerSoon(q);
      return toQuestionAuthorView(q, null);
    });
  }

  async getQuestion(
    p: Principal,
    tenant: string | undefined,
    id: string,
    version?: number,
  ): Promise<QuestionAuthorView> {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const q = await this.questions.get(tx, id, version);
      if (!q) throw new NotFoundError('QUESTION_NOT_FOUND', 'No such question.');
      const stats =
        (await this.questions.stats(tx, [id])).find((s) => s.version === q.version) ?? null;
      return toQuestionAuthorView(q, stats);
    });
  }

  async listQuestions(
    p: Principal,
    tenant: string | undefined,
    query: { bank_id?: string | undefined; limit: number },
  ) {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const list = await this.questions.list(tx, {
        limit: query.limit,
        ...(query.bank_id ? { bankId: query.bank_id } : {}),
      });
      const stats = await this.questions.stats(
        tx,
        list.map((q) => q.id),
      );
      return {
        items: list.map((q) =>
          toQuestionAuthorView(
            q,
            stats.find((s) => s.questionId === q.id && s.version === q.version) ?? null,
          ),
        ),
      };
    });
  }

  async retireQuestion(p: Principal, tenant: string | undefined, id: string): Promise<void> {
    const tenantId = tenantOf(p, tenant);
    const n = await withTenantTx(this.db, tenantId, (tx) =>
      this.questions.setStatus(tx, id, 'retired'),
    );
    if (n === 0) throw new NotFoundError('QUESTION_NOT_FOUND', 'No such question.');
  }

  private buildQuestion(
    tenantId: string,
    id: string,
    version: number,
    input: QuestionInput,
    by: string,
  ): Question {
    return {
      tenantId,
      id,
      version,
      bankId: input.bank_id,
      type: input.type,
      prompt: input.prompt,
      payload: parsePayload(input.type, input.payload),
      marks: input.marks,
      negativeMarks: Math.min(input.negative_marks, input.marks),
      difficulty: input.difficulty,
      skillIds: input.skill_ids,
      status: 'active',
      createdBy: by,
      createdAt: this.clock.now(),
    };
  }

  // --- Assessments ---------------------------------------------------------------------------

  async createAssessment(
    p: Principal,
    tenant: string | undefined,
    input: AssessmentInput,
  ): Promise<AssessmentView> {
    const tenantId = tenantOf(p, tenant);
    const now = this.clock.now();
    const a: Assessment = {
      tenantId,
      id: newId(),
      version: 1,
      title: input.title,
      candidateAlias: input.candidate_alias,
      kind: input.kind,
      status: 'draft',
      navigation: input.navigation,
      durationSeconds: input.duration_seconds,
      ...parseConfig(input),
      jobProfileId: input.job_profile_id,
      lockVersion: 0,
      createdBy: p.subject,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await withTenantTx(this.db, tenantId, (tx) => this.assessments.insert(tx, a));
    return toAssessmentView(a);
  }

  async getAssessment(
    p: Principal,
    tenant: string | undefined,
    id: string,
    version?: number,
  ): Promise<AssessmentView> {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) =>
      toAssessmentView(await this.load(tx, id, version)),
    );
  }

  async listAssessments(
    p: Principal,
    tenant: string | undefined,
    query: { limit: number; status?: string | undefined },
  ) {
    const tenantId = tenantOf(p, tenant);
    const items = await withTenantTx(this.db, tenantId, (tx) =>
      this.assessments.list(tx, {
        limit: query.limit,
        ...(query.status ? { status: query.status } : {}),
      }),
    );
    return { items: items.map(toAssessmentView) };
  }

  /** Drafts are editable (If-Match on lock_version); published versions never are. */
  async updateDraft(
    p: Principal,
    tenant: string | undefined,
    id: string,
    input: AssessmentInput,
    expectedLock: number,
  ): Promise<AssessmentView> {
    const tenantId = tenantOf(p, tenant);
    return translate(() =>
      withTenantTx(this.db, tenantId, async (tx) => {
        const current = await this.load(tx, id);
        if (current.status !== 'draft') {
          throw new DomainRuleError(
            'ASSESSMENT_PUBLISHED',
            'Published versions are immutable; create a new version.',
          );
        }
        const next: Assessment = {
          ...current,
          title: input.title,
          candidateAlias: input.candidate_alias,
          kind: input.kind,
          navigation: input.navigation,
          durationSeconds: input.duration_seconds,
          ...parseConfig(input),
          jobProfileId: input.job_profile_id,
        };
        if (!(await this.assessments.update(tx, next, expectedLock))) {
          throw new PreconditionFailedError(
            'VERSION_MISMATCH',
            'The assessment changed; reload it.',
          );
        }
        return toAssessmentView({ ...next, lockVersion: expectedLock + 1 });
      }),
    );
  }

  /** Pins every question version, validates bank sizes, freezes the version and announces it. */
  async publish(p: Principal, tenant: string | undefined, id: string): Promise<AssessmentView> {
    const tenantId = tenantOf(p, tenant);
    return translate(() =>
      withTenantTx(this.db, tenantId, async (tx) => {
        const a = await this.load(tx, id);
        if (a.status !== 'draft')
          throw new DomainRuleError('ALREADY_PUBLISHED', 'This version is already published.');
        const refs = a.definition.sections.flatMap((s) => s.questions);
        const latest = await this.questions.latest(
          tx,
          refs.map((r) => r.question_id),
        );
        const banks = await this.questions.bankQuestions(
          tx,
          a.definition.sections.flatMap((s) => s.banks.map((b) => b.bank_id)),
        );
        const pinned = pinDefinition(a.definition, latest, banks);
        const exact = await this.questions.versions(
          tx,
          pinned.sections.flatMap((s) =>
            s.questions.map((q) => ({ id: q.question_id, version: q.version ?? 0 })),
          ),
        );
        const missing = pinned.sections
          .flatMap((s) => s.questions)
          .find((q) => !exact.has(`${q.question_id}@${q.version}`));
        if (missing)
          throw new DomainRuleError(
            'QUESTION_NOT_FOUND',
            `Question ${missing.question_id}@${missing.version} does not exist.`,
          );
        const codingLanguages = await this.checkCodingQuestions([
          ...exact.values(),
          ...[...banks.values()].flat(),
        ]);
        const now = this.clock.now();
        const next: Assessment = {
          ...a,
          definition: pinned,
          status: 'published',
          publishedAt: now,
        };
        if (!(await this.assessments.update(tx, next, a.lockVersion))) {
          throw new PreconditionFailedError(
            'VERSION_MISMATCH',
            'The assessment changed; reload it.',
          );
        }
        const skillIds = new Set<string>();
        for (const q of exact.values()) q.skillIds.forEach((s) => skillIds.add(s));
        for (const list of banks.values())
          list.forEach((q) => q.skillIds.forEach((s) => skillIds.add(s)));
        await appendOutbox(
          tx,
          AssessmentPublished.build({
            tenantId,
            aggregateId: a.id,
            payload: {
              tenant_id: tenantId,
              assessment_id: a.id,
              version: a.version,
              kind: a.kind,
              skill_ids: [...skillIds].sort(),
              ...(codingLanguages.length ? { coding_languages: codingLanguages } : {}),
              occurred_at: now.toISOString(),
            },
          }),
        );
        return toAssessmentView({ ...next, lockVersion: a.lockVersion + 1 });
      }),
    );
  }

  /** Editing a published assessment: a new draft version n+1 (sessions keep their pinned version). */
  async newVersion(p: Principal, tenant: string | undefined, id: string): Promise<AssessmentView> {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const latest = await this.load(tx, id);
      if (latest.status === 'draft')
        throw new DomainRuleError('DRAFT_EXISTS', 'The latest version is still a draft; edit it.');
      const now = this.clock.now();
      const next: Assessment = {
        ...latest,
        version: latest.version + 1,
        status: 'draft',
        publishedAt: null,
        lockVersion: 0,
        createdAt: now,
        updatedAt: now,
        createdBy: p.subject,
      };
      await this.assessments.insert(tx, next);
      return toAssessmentView(next);
    });
  }

  async clone(p: Principal, tenant: string | undefined, id: string): Promise<AssessmentView> {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const source = await this.load(tx, id);
      const now = this.clock.now();
      const copy: Assessment = {
        ...source,
        id: newId(),
        version: 1,
        title: `${source.title} (copy)`.slice(0, 200),
        status: 'draft',
        publishedAt: null,
        lockVersion: 0,
        createdBy: p.subject,
        createdAt: now,
        updatedAt: now,
      };
      await this.assessments.insert(tx, copy);
      return toAssessmentView(copy);
    });
  }

  /** Publishes, deactivates or archives one version (the latest unless `version` is given). */
  async setStatus(
    p: Principal,
    tenant: string | undefined,
    id: string,
    status: 'inactive' | 'archived' | 'published',
    version?: number,
  ) {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const a = await this.load(tx, id, version);
      if (a.status === 'draft')
        throw new DomainRuleError('NOT_PUBLISHED', 'Publish the draft first.');
      const next = { ...a, status };
      if (!(await this.assessments.update(tx, next, a.lockVersion))) {
        throw new PreconditionFailedError('VERSION_MISMATCH', 'The assessment changed; reload it.');
      }
      return toAssessmentView({ ...next, lockVersion: a.lockVersion + 1 });
    });
  }

  // --- Invite links ------------------------------------------------------------------------------

  /** Open links (anyone with the link) or targeted invites (one candidate). The token is shown once. */
  async createInvite(
    p: Principal,
    tenant: string | undefined,
    id: string,
    input: {
      kind: 'open' | 'targeted';
      candidate_id: string | null;
      max_uses: number | null;
      expires_at: string | null;
    },
  ) {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const a = await this.load(tx, id);
      const live = a.status === 'published' ? a : await this.latestPublished(tx, id, a.version);
      if (!live)
        throw new DomainRuleError('NOT_PUBLISHED', 'Only a published assessment can be shared.');
      if (input.kind === 'targeted' && !input.candidate_id) {
        throw new DomainRuleError('CANDIDATE_REQUIRED', 'A targeted invite names its candidate.');
      }
      const token = `inv_${randomToken(24)}`;
      const invite: Invite = {
        tenantId,
        id: newId(),
        assessmentId: live.id,
        assessmentVersion: live.version,
        kind: input.kind,
        candidateId: input.kind === 'targeted' ? input.candidate_id : null,
        maxUses: input.kind === 'targeted' ? 1 : input.max_uses,
        uses: 0,
        expiresAt: input.expires_at ? new Date(input.expires_at) : null,
        revokedAt: null,
        createdBy: p.subject,
        createdAt: this.clock.now(),
      };
      await this.invites.insert(tx, invite, sha256(token));
      return {
        ...toInviteView(invite),
        token,
        url: `${this.settings.inviteBaseUrl.replace(/\/$/, '')}/${token}`,
      };
    });
  }

  async listInvites(p: Principal, tenant: string | undefined, id: string) {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => ({
      items: (await this.invites.list(tx, id)).map(toInviteView),
    }));
  }

  async revokeInvite(p: Principal, tenant: string | undefined, inviteId: string): Promise<void> {
    const tenantId = tenantOf(p, tenant);
    const ok = await withTenantTx(this.db, tenantId, (tx) =>
      this.invites.revoke(tx, inviteId, this.clock.now()),
    );
    if (!ok) throw new NotFoundError('INVITE_NOT_FOUND', 'No such active invite.');
  }

  private async latestPublished(tx: Tx, id: string, below: number): Promise<Assessment | null> {
    for (let v = below - 1; v >= 1; v--) {
      const a = await this.assessments.get(tx, id, v);
      if (a?.status === 'published') return a;
    }
    return null;
  }

  private async load(tx: Tx, id: string, version?: number): Promise<Assessment> {
    const a = await this.assessments.get(tx, id, version);
    if (!a) throw new NotFoundError('ASSESSMENT_NOT_FOUND', 'No such assessment.');
    return a;
  }
}

function parseConfig(input: AssessmentInput): {
  definition: Definition;
  settings: Settings;
  reportConfig: ReportConfig;
} {
  const definition = definitionSchema.safeParse(input.definition);
  if (!definition.success) {
    throw new DomainRuleError(
      'INVALID_DEFINITION',
      definition.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return {
    definition: definition.data,
    settings: settingsSchema.parse(input.settings ?? {}),
    reportConfig: reportConfigSchema.parse(input.report_config ?? {}),
  };
}

/** A coding question as sandbox-svc registers it; null without a reference solution. */
export function bundleOf(q: Question): SandboxBundle | null {
  if (q.type !== 'coding') return null;
  const p = q.payload as unknown as CodingPayload;
  if (!p.reference_solution) return null;
  return {
    languages: p.languages,
    tests: p.tests.map((t) => ({
      input: t.input,
      expected: t.expected,
      hidden: t.hidden,
      ...(t.weight === undefined ? {} : { weight: t.weight }),
    })),
    ...(p.checker ? { checker: p.checker } : {}),
    ...(p.limits ? { limits: p.limits } : {}),
    reference_solution: {
      language: p.reference_solution.language,
      source: p.reference_solution.code,
    },
  };
}
