import { Controller, Get, Param, Res } from '@nestjs/common';
import { isUuid, NotFoundError, Roles, Scopes } from '@atlas/platform';
import { TenantService } from '../application/tenant.service';

interface HeaderSink {
  setHeader(name: string, value: string): void;
}

/** Wrapped tenant data keys for encrypting services (service role, scope tenant-keys:read). */
@Controller('v1/tenants')
export class DataKeysController {
  constructor(private readonly service: TenantService) {}

  /** Tenant settings for platform services (service role, scope tenant-settings:read). */
  @Get(':id/settings')
  @Roles('service')
  @Scopes('tenant-settings:read')
  async settings(@Param('id') id: string) {
    if (!isUuid(id)) throw new NotFoundError('TENANT_NOT_FOUND', 'Tenant not found.');
    return this.service.settingsFor(id);
  }

  @Get(':id/data-keys')
  @Roles('service')
  @Scopes('tenant-keys:read')
  async dataKeys(@Param('id') id: string, @Res({ passthrough: true }) res: HeaderSink) {
    if (!isUuid(id)) throw new NotFoundError('TENANT_NOT_FOUND', 'Tenant not found.');
    res.setHeader('Cache-Control', 'no-store');
    return this.service.dataKeys(id);
  }
}
