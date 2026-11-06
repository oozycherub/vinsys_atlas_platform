import { PassThrough, Readable } from 'node:stream';
import { Inject, Injectable, Optional } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { type Logger } from 'pino';
import { ReportArtifactReady, REPORT_TYPES } from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  newId,
  withSystemTx,
  withTenantTx,
} from '@atlas/platform';
import { overallScore, type SessionFacts, status } from '../domain/facts';
import { bindGallery, galleryReport } from '../domain/gallery';
import { effectiveSections, normaliseSections } from '../domain/sections';
import {
  type ArtifactRow,
  type Claimed,
  type JobRow,
  type ReportStore,
  REPORT_STORE,
} from './store';
import { renderCandidateReport } from '../templates/candidate-report';
import {
  ARTIFACT_STORE,
  type ArtifactStore,
  DIRECTORY,
  type Directory,
  LAKEHOUSE,
  type Lakehouse,
  PDF_RENDERER,
  type PdfRenderer,
  PROCTORING_EVIDENCE,
  type ProctoringEvidence,
  REPORT_LOGGER,
  REPORT_SETTINGS,
  type ReportSettings,
  type StoredObject,
} from './ports';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PAGE = 500;
const MAX_FRAMES = 12;

/** A job that cannot succeed by retrying (its data is gone). */
class PermanentJobError extends Error {}

interface Output {
  key: string;
  stored: StoredObject;
  contentType: string;
  fileName: string;
}

/**
 * Generates reports (Component Prompt 13 §2, ADR-0010 §8–9). Jobs are leased across tenants,
 * rendered outside any transaction, stored, then recorded with `report.artifact.ready.v1`.
 */
@Injectable()
export class ReportWorker {
  private stopped = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PDF_RENDERER) private readonly pdf: PdfRenderer,
    @Inject(ARTIFACT_STORE) private readonly artifacts: ArtifactStore,
    @Inject(LAKEHOUSE) private readonly lakehouse: Lakehouse,
    @Inject(DIRECTORY) private readonly directory: Directory,
    @Inject(PROCTORING_EVIDENCE) private readonly evidence: ProctoringEvidence,
    @Inject(REPORT_SETTINGS) private readonly settings: ReportSettings,
    @Inject(REPORT_STORE) private readonly store: ReportStore,
    @Optional() @Inject(REPORT_LOGGER) private readonly logger: Logger | null,
  ) {}

  async runOnce(): Promise<number> {
    const now = this.clock.now();
    const claimed = await withSystemTx(this.db, (tx) =>
      this.store.claimJobs(
        tx,
        now,
        new Date(now.getTime() + this.settings.leaseMs),
        this.settings.batchSize,
      ),
    );
    for (const c of claimed) await this.process(c);
    return claimed.length;
  }

  async runForever(idleMs = 2000): Promise<void> {
    while (!this.stopped) {
      try {
        if ((await this.runOnce()) === 0) await new Promise((r) => setTimeout(r, idleMs));
      } catch (error) {
        this.logger?.error({ err: error }, 'report worker pass failed');
        await new Promise((r) => setTimeout(r, idleMs));
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async process(c: Claimed): Promise<void> {
    const job = await withTenantTx(this.db, c.tenantId, (tx) => this.store.job(tx, c.id));
    if (!job || job.status !== 'running') return;
    const started = Date.now();
    try {
      const reportId = job.reportId;
      const artifactId = newId();
      const out =
        job.type === 'candidate_assessment_pdf'
          ? await this.candidatePdf(c.tenantId, job, artifactId)
          : job.type === 'assessment_results_xlsx'
            ? await this.assessmentXlsx(c.tenantId, job, artifactId)
            : await this.galleryXlsx(c.tenantId, job, artifactId);
      const now = this.clock.now();
      const artifact: ArtifactRow = {
        artifactId,
        reportId,
        storageKey: out.key,
        contentType: out.contentType,
        fileName: out.fileName,
        sizeBytes: out.stored.sizeBytes,
        sha256: out.stored.sha256,
        subjectId: job.subjectId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.settings.artifactRetentionMs),
      };
      await withTenantTx(this.db, c.tenantId, async (tx) => {
        await this.store.insertArtifact(tx, c.tenantId, artifact);
        await this.store.finishJob(tx, reportId, artifactId, now);
        await appendOutbox(
          tx,
          ReportArtifactReady.build({
            tenantId: c.tenantId,
            aggregateId: reportId,
            payload: {
              tenant_id: c.tenantId,
              report_id: reportId,
              artifact_id: artifactId,
              type: job.type as (typeof REPORT_TYPES)[number],
              requested_by: job.requestedBy,
              content_type: out.contentType,
              size_bytes: out.stored.sizeBytes,
              occurred_at: now.toISOString(),
            },
          }),
        );
      });
      this.logger?.info(
        { tenant_id: c.tenantId, report_id: reportId, type: job.type, ms: Date.now() - started },
        'report ready',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = error instanceof PermanentJobError;
      await withTenantTx(this.db, c.tenantId, (tx) =>
        permanent || c.attempts >= this.settings.maxAttempts
          ? this.store.failJob(tx, job.reportId, message, this.clock.now())
          : this.store.retryJob(
              tx,
              job.reportId,
              new Date(this.clock.now().getTime() + 30_000 * 2 ** (c.attempts - 1)),
              message,
            ),
      );
      this.logger?.warn(
        { tenant_id: c.tenantId, report_id: job.reportId, attempts: c.attempts, err: message },
        'report failed',
      );
    }
  }

  private key(tenantId: string, job: JobRow, artifactId: string, ext: string): string {
    return `${tenantId}/${job.reportId}/${artifactId}.${ext}`;
  }

  // --- Candidate PDF ------------------------------------------------------------------------

  private async candidatePdf(tenantId: string, job: JobRow, artifactId: string): Promise<Output> {
    const sessionId = job.params['session_id'] as string;
    const loaded = await withTenantTx(this.db, tenantId, async (tx) => ({
      facts: await this.store.facts(tx, sessionId),
      sections: normaliseSections(await this.store.sections(tx)),
    }));
    if (!loaded.facts) throw new PermanentJobError('the session’s results are gone');
    const facts = loaded.facts;
    const sections = effectiveSections(
      loaded.sections,
      (job.params['sections'] as string[] | null) ?? null,
    );
    const skillIds = [
      ...new Set([
        ...(facts.skills ?? []).map((s) => s.skillId),
        ...(facts.interview?.competencies ?? []).map((c) => c.skillId),
      ]),
    ];
    const [candidateName, skillNames, frames] = await Promise.all([
      facts.candidateId
        ? this.directory.candidateName(tenantId, facts.candidateId)
        : Promise.resolve(null),
      skillIds.length
        ? this.directory.skillNames(tenantId, skillIds)
        : Promise.resolve(new Map<string, string>()),
      // Evidence images are fetched only when that section is on (Component Prompt 13 §6).
      sections.proctoring_evidence
        ? this.evidence.flaggedFrames(tenantId, facts.sessionId, MAX_FRAMES)
        : Promise.resolve([]),
    ]);
    const html = renderCandidateReport({
      tenantName: null,
      candidateName,
      facts,
      sections,
      skillNames,
      evidence: frames,
      generatedAt: this.clock.now(),
    });
    const pdf = await this.pdf.render(html);
    const key = this.key(tenantId, job, artifactId, 'pdf');
    const stored = await this.artifacts.put(key, Readable.from([pdf]), 'application/pdf');
    return {
      key,
      stored,
      contentType: 'application/pdf',
      fileName: `assessment-report-${sessionId.slice(0, 8)}.pdf`,
    };
  }

  // --- Excel exports (streamed) -------------------------------------------------------------

  private async streamWorkbook(
    key: string,
    write: (sheet: ExcelJS.Worksheet) => Promise<void>,
    sheetName: string,
  ): Promise<StoredObject> {
    const pass = new PassThrough();
    const upload = this.artifacts.put(key, pass, XLSX);
    try {
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: pass,
        useStyles: false,
        useSharedStrings: false,
      });
      const sheet = workbook.addWorksheet(sheetName);
      await write(sheet);
      await workbook.commit();
    } catch (error) {
      pass.destroy(error as Error);
      await upload.catch(() => undefined);
      throw error;
    }
    return upload;
  }

  private async assessmentXlsx(tenantId: string, job: JobRow, artifactId: string): Promise<Output> {
    const assessmentId = job.params['assessment_id'] as string;
    const skillIds = await withTenantTx(this.db, tenantId, (tx) =>
      this.store.assessmentSkillIds(tx, assessmentId),
    );
    const names = skillIds.length
      ? await this.directory.skillNames(tenantId, skillIds)
      : new Map<string, string>();
    const key = this.key(tenantId, job, artifactId, 'xlsx');
    const stored = await this.streamWorkbook(
      key,
      async (sheet) => {
        sheet
          .addRow([
            'Session',
            'Candidate',
            'Attempt',
            'Submitted (UTC)',
            'Status',
            'Overall score',
            'Trust Score',
            'Trust band',
            'Interview recommendation',
            ...skillIds.map((id) => names.get(id) ?? id),
          ])
          .commit();
        let after: string | null = null;
        for (;;) {
          const page: SessionFacts[] = await withTenantTx(this.db, tenantId, (tx) =>
            this.store.factsPage(tx, assessmentId, after, PAGE),
          );
          for (const f of page) {
            const bySkill = new Map((f.skills ?? []).map((s) => [s.skillId, s.score]));
            const overall = overallScore(f.skills);
            sheet
              .addRow([
                f.sessionId,
                f.candidateId,
                f.attemptNo,
                f.submittedAt?.toISOString() ?? null,
                status(f),
                overall === null ? null : Math.round(overall * 100) / 100,
                f.trustScore,
                f.trustBand,
                f.interview?.recommendation ?? null,
                ...skillIds.map((id) => bySkill.get(id) ?? null),
              ])
              .commit();
          }
          if (page.length < PAGE) break;
          after = (page[page.length - 1] as SessionFacts).sessionId;
        }
      },
      'Results',
    );
    return {
      key,
      stored,
      contentType: XLSX,
      fileName: `assessment-results-${assessmentId.slice(0, 8)}.xlsx`,
    };
  }

  private async galleryXlsx(tenantId: string, job: JobRow, artifactId: string): Promise<Output> {
    const report = galleryReport(job.params['report'] as string);
    if (!report) throw new PermanentJobError('unknown gallery report');
    const bound = bindGallery(
      report,
      tenantId,
      (job.params['values'] as Record<string, unknown>) ?? {},
    );
    if (bound.problems.length) throw new PermanentJobError(bound.problems.join('; '));
    const result = await this.lakehouse.query(report.sql, bound.params);
    const key = this.key(tenantId, job, artifactId, 'xlsx');
    const stored = await this.streamWorkbook(
      key,
      async (sheet) => {
        sheet.addRow(result.columns).commit();
        for await (const row of result.rows) sheet.addRow(row).commit();
      },
      report.title.slice(0, 31),
    );
    return { key, stored, contentType: XLSX, fileName: `${report.key}.xlsx` };
  }
}
