import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Role } from '@atlas/contracts';
import { TOKEN_VERIFIER, type TokenVerifier } from '../auth/jwt';
import { hasAnyRole } from '../auth/principal';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { requestContext } from '../logging';
import {
  type AuthenticatedRequest,
  IS_PUBLIC,
  REQUIRED_ROLES,
  REQUIRED_SCOPES,
} from './decorators';

interface HeaderRequest extends AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Global guard: authenticates every route unless @Public(), then enforces @Roles/@Scopes.
 * A route with neither @Public nor @Roles is rejected, so a forgotten decorator fails closed.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<HeaderRequest>();
    const header = request.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    const match = value ? /^Bearer\s+(\S+)$/i.exec(value) : null;
    if (!match?.[1]) throw new UnauthorizedError();

    const principal = await this.verifier.verify(match[1]);
    request.principal = principal;
    const ctx = requestContext.getStore();
    if (ctx) {
      ctx.subject = principal.subject;
      if (principal.tenantId) ctx.tenantId = principal.tenantId;
    }

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(REQUIRED_ROLES, targets);
    if (!roles || roles.length === 0) {
      throw new ForbiddenError('This route has no access policy; access is denied by default.');
    }
    if (!hasAnyRole(principal, roles)) throw new ForbiddenError();

    const scopes =
      this.reflector.getAllAndOverride<string[] | undefined>(REQUIRED_SCOPES, targets) ?? [];
    if (!scopes.every((scope) => principal.scopes.includes(scope))) {
      throw new ForbiddenError('The token lacks a required scope.');
    }
    return true;
  }
}
