import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { type Role } from '@atlas/contracts';
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
import { ReportsService } from '../application/reports.service';
import { downloadQuery, reportBody, settingsBody, tenantQuery } from './dto';

const ANYONE: Role[] = [
  'tenant_admin',
  'hiring_manager',
  'recruiter',
  'reviewer',
  'employee',
  'super_admin',
  'service',
];

function id(raw: string, what: string): string {
  if (!isUuid(raw)) throw new NotFoundError(`${what}_NOT_FOUND`, 'Not found.');
  return raw.toLowerCase();
}
const tenant = (q: unknown) => parseInput(tenantQuery, q, 'query').tenant_id;

interface DownloadResponse {
  setHeader(name: string, value: string): void;
}

@Controller('v1')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('report-settings')
  @Roles(...ANYONE)
  settings(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return this.reports.getSettings(p, tenant(q));
  }

  @Put('report-settings')
  @Roles(...ANYONE)
  putSettings(@CurrentPrincipal() p: Principal, @Query() q: unknown, @Body() body: unknown) {
    return this.reports.putSettings(p, parseInput(settingsBody, body).sections, tenant(q));
  }

  @Get('report-gallery')
  @Roles(...ANYONE)
  gallery(@CurrentPrincipal() p: Principal) {
    return { items: this.reports.gallery(p) };
  }

  @Post('reports')
  @Roles(...ANYONE)
  @HttpCode(202)
  request(@CurrentPrincipal() p: Principal, @Query() q: unknown, @Body() body: unknown) {
    return this.reports.request(p, parseInput(reportBody, body), tenant(q));
  }

  @Get('reports')
  @Roles(...ANYONE)
  async list(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return { items: await this.reports.list(p, tenant(q)) };
  }

  @Get('reports/:id')
  @Roles(...ANYONE)
  get(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.reports.get(p, id(raw, 'REPORT'), tenant(q));
  }

  /** The signed link is the credential (ADR-0010 §7); no bearer token. */
  @Get('report-artifacts/:id\\:download')
  @Public()
  async download(
    @Param('id') raw: string,
    @Query() q: unknown,
    @Res({ passthrough: true }) res: DownloadResponse,
  ): Promise<StreamableFile> {
    const artifactId = id(raw, 'ARTIFACT');
    const parsed = downloadQuery.safeParse(q);
    if (!parsed.success) throw new NotFoundError('ARTIFACT_NOT_FOUND', 'Not found.');
    const file = await this.reports.download(artifactId, parsed.data);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return new StreamableFile(file.body, {
      type: file.contentType,
      length: file.sizeBytes,
      disposition: `attachment; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    });
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
