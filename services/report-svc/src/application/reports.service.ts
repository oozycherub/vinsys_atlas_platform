import { type Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { type Role } from '@atlas/contracts';
import {
  BadRequestError,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  ForbiddenError,
  hasAnyRole,
  isSuperAdmin,
  isUuid,
  NotFoundError,
  newId,
  type Principal,
  ValidationError,
  withTenantTx,
} from '@atlas/platform';
import { bindGallery, GALLERY, galleryReport } from '../domain/gallery';
import { signLink, verifyLink } from '../domain/links';
import { normaliseSections, SECTION_KEYS, SECTIONS, type SectionConfig } from '../domain/sections';
import { type JobRow, type ReportStore, REPORT_STORE } from './store';
import { ARTIFACT_STORE, type ArtifactStore, REPORT_SETTINGS, type ReportSettings } from './ports';

export const ADMINS: Role[] = ['tenant_admin', 'super_admin'];
/** Staff who read candidate results. */
export const STAFF: Role[] = [
  'tenant_admin',
  'recruiter',
  'hiring_manager',
  'reviewer',
  'super_admin',
];
/** Workforce analytics (the gallery). */
export const ANALYSTS: Role[] = ['tenant_admin', 'hiring_manager', 'super_admin'];

export function tenantOf(p: Principal, requested: string | undefined): string {
  if (p.tenantId) {
    if (requested !== undefined && requested !== p.tenantId)
      throw new NotFoundError('NOT_FOUND', 'Not found.');
    return p.tenantId;
  }
  if (isSuperAdmin(p)) {
    if (!requested || !isUuid(requested))
      throw new BadRequestError('TENANT_ID_REQUIRED', 'Platform principals must pass tenant_id.');
    return requested;
  }
  throw new ForbiddenError('This token is not bound to a tenant.');
}

function requireRole(p: Principal, roles: readonly Role[]): void {
  if (!hasAnyRole(p, roles)) throw new ForbiddenError('Your role cannot do this.');
}

export type ReportRequest =
  | {
      type: 'candidate_assessment_pdf';
      params: { session_id: string; sections?: string[] | undefined };
    }
  | { type: 'assessment_results_xlsx'; params: { assessment_id: string } }
  | { type: 'gallery_xlsx'; params: { report: string; values: Record<string, unknown> } };

export interface ReportView {
  report_id: string;
  type: string;
  status: string;
  params: Record<string, unknown>;
  requested_by: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  download: {
    url: string;
    expires_at: string;
    file_name: string;
    content_type: string;
    size_bytes: number;
  } | null;
}

/** Report API (Component Prompt 13 §4): settings, the gallery, requests and signed downloads. */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ARTIFACT_STORE) private readonly artifacts: ArtifactStore,
    @Inject(REPORT_SETTINGS) private readonly settings: ReportSettings,
    @Inject(REPORT_STORE) private readonly store: ReportStore,
  ) {}

  // --- Settings -----------------------------------------------------------------------------

  private viewSections(s: SectionConfig) {
    return {
      sections: SECTION_KEYS.map((key) => ({
        key,
        title: SECTIONS[key].title,
        mandatory: SECTIONS[key].mandatory,
        enabled: s[key],
      })),
    };
  }

  async getSettings(p: Principal, tenant?: string) {
    requireRole(p, STAFF);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) =>
      this.viewSections(normaliseSections(await this.store.sections(tx))),
    );
  }

  async putSettings(p: Principal, sections: { key: string; enabled: boolean }[], tenant?: string) {
    requireRole(p, ADMINS);
    const tenantId = tenantOf(p, tenant);
    const problems = sections
      .filter(
        (s) =>
          !(SECTION_KEYS as string[]).includes(s.key) ||
          (SECTIONS[s.key as keyof typeof SECTIONS].mandatory && !s.enabled),
      )
      .map((s) => ({
        path: `sections.${s.key}`,
        message: (SECTION_KEYS as string[]).includes(s.key) ? 'is mandatory' : 'unknown section',
      }));
    if (problems.length) throw new ValidationError('Invalid report sections.', problems);
    const config = normaliseSections(Object.fromEntries(sections.map((s) => [s.key, s.enabled])));
    await withTenantTx(this.db, tenantId, (tx) =>
      this.store.saveSections(tx, tenantId, config, p.subject, this.clock.now()),
    );
    return this.viewSections(config);
  }

  gallery(p: Principal) {
    requireRole(p, ANALYSTS);
    return GALLERY.map((g) => ({
      key: g.key,
      title: g.title,
      description: g.description,
      params: g.params,
    }));
  }

  // --- Requests -----------------------------------------------------------------------------

  async request(p: Principal, input: ReportRequest, tenant?: string): Promise<ReportView> {
    const tenantId = tenantOf(p, tenant);
    const reportId = newId();
    const now = this.clock.now();
    return withTenantTx(this.db, tenantId, async (tx) => {
      let subjectId: string | null = null;
      let params: Record<string, unknown>;
      if (input.type === 'candidate_assessment_pdf') {
        requireRole(p, STAFF);
        const facts = await this.store.facts(tx, input.params.session_id);
        if (!facts) throw new NotFoundError('SESSION_NOT_FOUND', 'No results for this session.');
        if (input.params.sections) {
          const unknown = input.params.sections.filter(
            (s) => !(SECTION_KEYS as string[]).includes(s),
          );
          if (unknown.length)
            throw new ValidationError(
              'Unknown sections.',
              unknown.map((s) => ({ path: 'params.sections', message: s })),
            );
        }
        subjectId = facts.candidateId;
        params = { session_id: input.params.session_id, sections: input.params.sections ?? null };
      } else if (input.type === 'assessment_results_xlsx') {
        requireRole(p, [...ADMINS, 'recruiter', 'hiring_manager']);
        if (!(await this.store.assessmentExists(tx, input.params.assessment_id)))
          throw new NotFoundError('ASSESSMENT_NOT_FOUND', 'No results for this assessment.');
        params = { assessment_id: input.params.assessment_id };
      } else {
        requireRole(p, ANALYSTS);
        const report = galleryReport(input.params.report);
        if (!report)
          throw new ValidationError('Unknown gallery report.', [
            { path: 'params.report', message: input.params.report },
          ]);
        const bound = bindGallery(report, tenantId, input.params.values);
        if (bound.problems.length)
          throw new ValidationError(
            'Invalid report parameters.',
            bound.problems.map((m) => ({ path: 'params.values', message: m })),
          );
        params = { report: report.key, values: input.params.values };
      }
      const job: JobRow = {
        reportId,
        type: input.type,
        params,
        subjectId,
        requestedBy: p.subject,
        status: 'queued',
        attempts: 0,
        error: null,
        artifactId: null,
        createdAt: now,
        finishedAt: null,
      };
      await this.store.insertJob(tx, tenantId, job);
      return this.view(tenantId, job, null);
    });
  }

  private canSee(p: Principal, job: JobRow): boolean {
    return job.requestedBy === p.subject || hasAnyRole(p, ADMINS);
  }

  async get(p: Principal, id: string, tenant?: string): Promise<ReportView> {
    requireRole(p, STAFF);
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const job = await this.store.job(tx, id);
      if (!job || !this.canSee(p, job))
        throw new NotFoundError('REPORT_NOT_FOUND', 'Report not found.');
      const artifact = job.artifactId ? await this.store.artifact(tx, job.artifactId) : null;
      return this.view(tenantId, job, artifact);
    });
  }

  async list(p: Principal, tenant?: string): Promise<ReportView[]> {
    requireRole(p, STAFF);
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const jobs = await this.store.jobs(tx, hasAnyRole(p, ADMINS) ? null : p.subject, 100);
      return jobs.map((j) => this.view(tenantId, j, null));
    });
  }

  private view(
    tenantId: string,
    job: JobRow,
    artifact: Awaited<ReturnType<ReportStore['artifact']>>,
  ): ReportView {
    const now = this.clock.now().getTime();
    let download: ReportView['download'] = null;
    if (artifact && artifact.expiresAt.getTime() > now) {
      const exp = Math.floor((now + this.settings.linkTtlMs) / 1000);
      const sig = signLink(this.settings.linkKey, tenantId, artifact.artifactId, exp);
      download = {
        url: `${this.settings.publicBaseUrl.replace(/\/$/, '')}/v1/report-artifacts/${artifact.artifactId}:download?tenant_id=${tenantId}&exp=${exp}&sig=${sig}`,
        expires_at: new Date(exp * 1000).toISOString(),
        file_name: artifact.fileName,
        content_type: artifact.contentType,
        size_bytes: artifact.sizeBytes,
      };
    }
    return {
      report_id: job.reportId,
      type: job.type,
      status: job.status,
      params: job.params,
      requested_by: job.requestedBy,
      error: job.status === 'failed' ? job.error : null,
      created_at: job.createdAt.toISOString(),
      finished_at: job.finishedAt?.toISOString() ?? null,
      download,
    };
  }

  /** The signed link is the credential: no token, 15 minutes, this tenant and artifact only. */
  async download(
    artifactId: string,
    q: { tenant_id: string; exp: number; sig: string },
  ): Promise<{ body: Readable; contentType: string; fileName: string; sizeBytes: number }> {
    const verdict = verifyLink(
      this.settings.linkKey,
      q.tenant_id,
      artifactId,
      q.exp,
      q.sig,
      this.clock.now().getTime(),
      this.settings.linkTtlMs,
    );
    if (verdict === 'expired')
      throw new ForbiddenError('This download link has expired; request a new one.');
    if (verdict === 'invalid') throw new NotFoundError('ARTIFACT_NOT_FOUND', 'Not found.');
    const artifact = await withTenantTx(this.db, q.tenant_id, (tx) =>
      this.store.artifact(tx, artifactId),
    );
    if (!artifact || artifact.expiresAt <= this.clock.now())
      throw new NotFoundError('ARTIFACT_NOT_FOUND', 'Not found.');
    return {
      body: await this.artifacts.get(artifact.storageKey),
      contentType: artifact.contentType,
      fileName: artifact.fileName,
      sizeBytes: artifact.sizeBytes,
    };
  }
}
