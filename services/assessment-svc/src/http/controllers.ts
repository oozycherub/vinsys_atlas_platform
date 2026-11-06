import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  CurrentPrincipal,
  DATABASE,
  type Database,
  isUuid,
  NotFoundError,
  parseInput,
  type Principal,
  Public,
  Roles,
  ServiceUnavailableError,
} from '@atlas/platform';
import { AUTHORS, MANAGERS, RESULT_READERS } from '../application/access';
import { AuthoringService } from '../application/authoring.service';
import { ResultsService } from '../application/results.service';
import { RuntimeService } from '../application/runtime.service';
import {
  assessmentBody,
  bankBody,
  candidateStatusBody,
  etag,
  inviteBody,
  listAssessmentsQuery,
  listQuestionsQuery,
  parseIfMatch,
  codeSubmissionBody,
  questionBody,
  redeemBody,
  runBody,
  startProctoringBody,
  waitQuery,
  reviewBody,
  reviewersBody,
  saveBody,
  sessionsQuery,
  statusBody,
  tenantQuery,
  versionQuery,
} from './dto';

interface HeaderSink {
  status(code: number): unknown;
  setHeader(name: string, value: string): void;
}

interface StreamSink extends HeaderSink {
  write(chunk: string): boolean;
  end(): void;
  flushHeaders?(): void;
  on(event: 'close', listener: () => void): unknown;
}

function id(raw: string, what = 'RESOURCE'): string {
  if (!isUuid(raw)) throw new NotFoundError(`${what}_NOT_FOUND`, 'Not found.');
  return raw;
}

const tenant = (query: unknown) => parseInput(tenantQuery, query, 'query').tenant_id;

@Controller('v1')
export class AuthoringController {
  constructor(private readonly authoring: AuthoringService) {}

  @Post('question-banks')
  @Roles(...AUTHORS)
  createBank(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    const b = parseInput(bankBody, body);
    return this.authoring.createBank(p, b.tenant_id, b);
  }

  @Post('questions')
  @Roles(...AUTHORS)
  createQuestion(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    const b = parseInput(questionBody, body);
    return this.authoring.createQuestion(p, b.tenant_id, b);
  }

  @Get('questions')
  @Roles(...AUTHORS)
  listQuestions(@CurrentPrincipal() p: Principal, @Query() query: unknown) {
    const q = parseInput(listQuestionsQuery, query, 'query');
    return this.authoring.listQuestions(p, q.tenant_id, q);
  }

  @Get('questions/:id')
  @Roles(...AUTHORS)
  getQuestion(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() query: unknown) {
    const q = parseInput(versionQuery, query, 'query');
    return this.authoring.getQuestion(p, q.tenant_id, id(raw, 'QUESTION'), q.version);
  }

  /** A new version of the question (versions are immutable). */
  @Put('questions/:id')
  @Roles(...AUTHORS)
  reviseQuestion(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Body() body: unknown,
  ) {
    const b = parseInput(questionBody, body);
    return this.authoring.reviseQuestion(p, b.tenant_id, id(raw, 'QUESTION'), b);
  }

  @Post('questions/:id\\:retire')
  @HttpCode(204)
  @Roles(...AUTHORS)
  async retire(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() query: unknown,
  ): Promise<void> {
    await this.authoring.retireQuestion(p, tenant(query), id(raw, 'QUESTION'));
  }

  @Post('assessments')
  @Roles(...AUTHORS)
  async createAssessment(
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ) {
    const b = parseInput(assessmentBody, body);
    const view = await this.authoring.createAssessment(p, b.tenant_id, b);
    res.setHeader('ETag', etag(view.lock_version));
    return view;
  }

  @Get('assessments')
  @Roles(...RESULT_READERS)
  listAssessments(@CurrentPrincipal() p: Principal, @Query() query: unknown) {
    const q = parseInput(listAssessmentsQuery, query, 'query');
    return this.authoring.listAssessments(p, q.tenant_id, q);
  }

  @Get('assessments/:id')
  @Roles(...RESULT_READERS)
  async getAssessment(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ) {
    const q = parseInput(versionQuery, query, 'query');
    const view = await this.authoring.getAssessment(
      p,
      q.tenant_id,
      id(raw, 'ASSESSMENT'),
      q.version,
    );
    res.setHeader('ETag', etag(view.lock_version));
    return view;
  }

  @Put('assessments/:id')
  @Roles(...AUTHORS)
  async updateDraft(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ) {
    const expected = parseIfMatch(ifMatch);
    const b = parseInput(assessmentBody, body);
    const view = await this.authoring.updateDraft(
      p,
      b.tenant_id,
      id(raw, 'ASSESSMENT'),
      b,
      expected,
    );
    res.setHeader('ETag', etag(view.lock_version));
    return view;
  }

  @Post('assessments/:id\\:publish')
  @HttpCode(200)
  @Roles(...MANAGERS)
  publish(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() query: unknown) {
    return this.authoring.publish(p, tenant(query), id(raw, 'ASSESSMENT'));
  }

  @Post('assessments/:id\\:newVersion')
  @Roles(...AUTHORS)
  newVersion(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() query: unknown) {
    return this.authoring.newVersion(p, tenant(query), id(raw, 'ASSESSMENT'));
  }

  @Post('assessments/:id\\:clone')
  @Roles(...AUTHORS)
  clone(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() query: unknown) {
    return this.authoring.clone(p, tenant(query), id(raw, 'ASSESSMENT'));
  }

  @Post('assessments/:id\\:setStatus')
  @HttpCode(200)
  @Roles(...MANAGERS)
  setStatus(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() query: unknown,
    @Body() body: unknown,
  ) {
    const q = parseInput(versionQuery, query, 'query');
    return this.authoring.setStatus(
      p,
      q.tenant_id,
      id(raw, 'ASSESSMENT'),
      parseInput(statusBody, body).status,
      q.version,
    );
  }

  @Post('assessments/:id/invite-links')
  @Roles(...MANAGERS)
  createInvite(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() query: unknown,
    @Body() body: unknown,
  ) {
    return this.authoring.createInvite(
      p,
      tenant(query),
      id(raw, 'ASSESSMENT'),
      parseInput(inviteBody, body),
    );
  }

  @Get('assessments/:id/invite-links')
  @Roles(...MANAGERS)
  listInvites(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() query: unknown) {
    return this.authoring.listInvites(p, tenant(query), id(raw, 'ASSESSMENT'));
  }

  @Delete('invite-links/:id')
  @HttpCode(204)
  @Roles(...MANAGERS)
  async revokeInvite(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() query: unknown,
  ): Promise<void> {
    await this.authoring.revokeInvite(p, tenant(query), id(raw, 'INVITE'));
  }
}

@Controller('v1')
export class ResultsController {
  constructor(private readonly results: ResultsService) {}

  @Get('assessments/:id/sessions')
  @Roles(...RESULT_READERS)
  list(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() query: unknown) {
    const q = parseInput(sessionsQuery, query, 'query');
    return this.results.list(p, q.tenant_id, id(raw, 'ASSESSMENT'), {
      limit: q.limit,
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.band ? { band: q.band } : {}),
      ...(q.min_percent !== undefined ? { minPercent: q.min_percent } : {}),
      ...(q.candidate_status ? { candidateStatus: q.candidate_status } : {}),
      ...(q.review_status ? { reviewStatus: q.review_status } : {}),
    });
  }

  @Get('sessions/:id/result')
  @Roles(...RESULT_READERS)
  result(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() query: unknown) {
    return this.results.result(p, tenant(query), id(raw, 'SESSION'));
  }

  @Post('sessions/:id/reviewers')
  @Roles(...MANAGERS)
  assign(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() query: unknown,
    @Body() body: unknown,
  ) {
    return this.results.assignReviewers(
      p,
      tenant(query),
      id(raw, 'SESSION'),
      parseInput(reviewersBody, body).reviewer_ids,
    );
  }

  @Post('sessions/:id\\:review')
  @HttpCode(200)
  @Roles('reviewer', 'sme', 'recruiter', 'tenant_admin', 'hiring_manager')
  review(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() query: unknown,
    @Body() body: unknown,
  ) {
    const b = parseInput(reviewBody, body);
    return this.results.review(p, tenant(query), id(raw, 'SESSION'), b.scores, b.comment);
  }

  @Patch('sessions/:id/candidate-status')
  @Roles('tenant_admin', 'recruiter', 'hiring_manager', 'super_admin', 'service')
  async candidateStatus(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ) {
    const view = await this.results.candidateStatus(
      p,
      tenant(query),
      id(raw, 'SESSION'),
      parseInput(candidateStatusBody, body).status,
      parseIfMatch(ifMatch),
    );
    res.setHeader('ETag', etag(view.lock_version));
    return view;
  }
}

/**
 * The candidate runtime. Public to the JWT guard: candidates authenticate with their session
 * token (`Authorization: Session ast_…`), which RuntimeService verifies on every call.
 */
@Controller('v1')
export class RuntimeController {
  constructor(private readonly runtime: RuntimeService) {}

  @Post('invite-links/:token\\:redeem')
  @Public()
  @HttpCode(201)
  redeem(@Param('token') token: string, @Body() body: unknown) {
    if (!/^inv_[A-Za-z0-9_-]{20,80}$/.test(token))
      throw new NotFoundError('INVITE_NOT_FOUND', 'This invite link is not valid.');
    return this.runtime.redeem(
      token,
      parseInput(redeemBody, body && Object.keys(body).length ? body : undefined),
    );
  }

  @Get('sessions/:id')
  @Public()
  async state(@Param('id') raw: string, @Headers('authorization') auth: string | undefined) {
    return this.runtime.state(await this.runtime.authenticate(id(raw, 'SESSION'), auth));
  }

  @Post('sessions/:id\\:start')
  @Public()
  @HttpCode(200)
  async start(@Param('id') raw: string, @Headers('authorization') auth: string | undefined) {
    return this.runtime.start(await this.runtime.authenticate(id(raw, 'SESSION'), auth));
  }

  @Post('sessions/:id\\:heartbeat')
  @Public()
  @HttpCode(200)
  async heartbeat(@Param('id') raw: string, @Headers('authorization') auth: string | undefined) {
    return this.runtime.heartbeat(await this.runtime.authenticate(id(raw, 'SESSION'), auth));
  }

  @Get('sessions/:id/questions/:n')
  @Public()
  async question(
    @Param('id') raw: string,
    @Param('n') n: string,
    @Headers('authorization') auth: string | undefined,
  ) {
    const index = Number(n);
    if (!Number.isInteger(index) || index < 1)
      throw new NotFoundError('QUESTION_NOT_FOUND', 'No such question.');
    return this.runtime.question(await this.runtime.authenticate(id(raw, 'SESSION'), auth), index);
  }

  @Put('sessions/:id/responses/:qid')
  @Public()
  async save(
    @Param('id') raw: string,
    @Param('qid') qid: string,
    @Headers('authorization') auth: string | undefined,
    @Body() body: unknown,
  ) {
    const b = parseInput(saveBody, body);
    return this.runtime.save(
      await this.runtime.authenticate(id(raw, 'SESSION'), auth),
      id(qid, 'QUESTION'),
      b.client_rev,
      b.answer,
    );
  }

  /** Proctoring: after the pre-check, with biometric consent (forwarded to proctoring-svc). */
  @Post('sessions/:id\\:startProctoring')
  @Public()
  @HttpCode(200)
  async startProctoring(
    @Param('id') raw: string,
    @Headers('authorization') auth: string | undefined,
    @Body() body: unknown,
  ) {
    const b = parseInput(startProctoringBody, body);
    return this.runtime.startProctoring(
      await this.runtime.authenticate(id(raw, 'SESSION'), auth),
      b.consent,
    );
  }

  /** AI interview: starts the interview for this question (forwarded to interview-svc). */
  @Post('sessions/:id/questions/:qid\\:startInterview')
  @Public()
  @HttpCode(200)
  async startInterview(
    @Param('id') raw: string,
    @Param('qid') qid: string,
    @Headers('authorization') auth: string | undefined,
  ) {
    return this.runtime.startInterview(
      await this.runtime.authenticate(id(raw, 'SESSION'), auth),
      id(qid, 'QUESTION'),
    );
  }

  /** Coding: run against the sample tests or custom stdin (forwarded to sandbox-svc). */
  @Post('sessions/:id/questions/:qid/runs')
  @Public()
  @HttpCode(202)
  async runCode(
    @Param('id') raw: string,
    @Param('qid') qid: string,
    @Headers('authorization') auth: string | undefined,
    @Body() body: unknown,
  ) {
    const b = parseInput(runBody, body);
    return this.runtime.runCode(
      await this.runtime.authenticate(id(raw, 'SESSION'), auth),
      id(qid, 'QUESTION'),
      { language: b.language, code: b.code, ...(b.stdin === undefined ? {} : { stdin: b.stdin }) },
    );
  }

  @Get('sessions/:id/runs/:runId')
  @Public()
  async getRun(
    @Param('id') raw: string,
    @Param('runId') runId: string,
    @Headers('authorization') auth: string | undefined,
    @Query() query: unknown,
  ) {
    const q = parseInput(waitQuery, query);
    return this.runtime.getRun(
      await this.runtime.authenticate(id(raw, 'SESSION'), auth),
      id(runId, 'RUN'),
      q.wait,
    );
  }

  /** Coding: submit for judging against all tests (same code = same submission). */
  @Post('sessions/:id/questions/:qid/submissions')
  @Public()
  @HttpCode(202)
  async submitCode(
    @Param('id') raw: string,
    @Param('qid') qid: string,
    @Headers('authorization') auth: string | undefined,
    @Body() body: unknown,
  ) {
    const b = parseInput(codeSubmissionBody, body);
    return this.runtime.submitCode(
      await this.runtime.authenticate(id(raw, 'SESSION'), auth),
      id(qid, 'QUESTION'),
      b,
    );
  }

  @Get('sessions/:id/submissions/:submissionId')
  @Public()
  async getSubmission(
    @Param('id') raw: string,
    @Param('submissionId') submissionId: string,
    @Headers('authorization') auth: string | undefined,
  ) {
    return this.runtime.getSubmission(
      await this.runtime.authenticate(id(raw, 'SESSION'), auth),
      id(submissionId, 'SUBMISSION'),
    );
  }

  @Post('sessions/:id\\:submit')
  @Public()
  @HttpCode(200)
  async submit(@Param('id') raw: string, @Headers('authorization') auth: string | undefined) {
    return this.runtime.submit(await this.runtime.authenticate(id(raw, 'SESSION'), auth));
  }

  /** SSE: state on change, time warnings, pause/resume, termination, end. */
  @Get('sessions/:id/events')
  @Public()
  async events(
    @Param('id') raw: string,
    @Headers('authorization') auth: string | undefined,
    @Res() res: StreamSink,
  ) {
    const session = await this.runtime.authenticate(id(raw, 'SESSION'), auth);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders?.();
    let open = true;
    res.on('close', () => {
      open = false;
    });
    for await (const event of this.runtime.events(session)) {
      if (!open) break;
      res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
    }
    res.end();
  }
}

@Controller()
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get('healthz')
  @Public()
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @Public()
  async readyz(): Promise<{ status: 'ready' }> {
    try {
      await this.db.ping();
    } catch {
      throw new ServiceUnavailableError('NOT_READY', 'The database is not reachable.');
    }
    return { status: 'ready' };
  }
}
