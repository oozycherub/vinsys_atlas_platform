import { Controller, Get, Inject, Query } from '@nestjs/common';
import {
  DATABASE,
  type Database,
  parseInput,
  Public,
  Roles,
  Scopes,
  ServiceUnavailableError,
} from '@atlas/platform';
import { TenantService } from '../application/tenant.service';
import { type DirectoryEntry } from '../application/tenant-view';
import { resolveQuery } from './dto';

export const DIRECTORY_READ_SCOPE = 'tenant-directory:read';

@Controller('v1')
export class DirectoryController {
  constructor(private readonly service: TenantService) {}

  /** GET /v1/tenant-directory:resolve?slug=acme. Used by the API gateway (cached 60 s there). */
  @Get('tenant-directory\\:resolve')
  @Roles('service')
  @Scopes(DIRECTORY_READ_SCOPE)
  resolve(@Query() query: unknown): Promise<DirectoryEntry> {
    return this.service.resolve(parseInput(resolveQuery, query, 'query').slug);
  }
}

@Controller()
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get('healthz')
  @Public()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @Public()
  async ready(): Promise<{ status: 'ready' }> {
    try {
      await this.db.ping();
    } catch {
      throw new ServiceUnavailableError('DEPENDENCY_UNAVAILABLE', 'The database is not reachable.');
    }
    return { status: 'ready' };
  }
}
