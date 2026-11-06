import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { type Role } from '@atlas/contracts';
import { type Principal } from '../auth/principal';
import { UnauthorizedError } from '../errors';

export const IS_PUBLIC = 'atlas:isPublic';
export const REQUIRED_ROLES = 'atlas:requiredRoles';
export const REQUIRED_SCOPES = 'atlas:requiredScopes';

/** Opts a route out of authentication. Every other route is deny-by-default (§4.11). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** Caller needs at least one of these roles. */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ROLES, roles);

/** Caller needs every one of these scopes (machine principals). */
export const Scopes = (...scopes: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_SCOPES, scopes);

export interface AuthenticatedRequest {
  principal?: Principal;
}

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.principal) throw new UnauthorizedError();
    return request.principal;
  },
);
