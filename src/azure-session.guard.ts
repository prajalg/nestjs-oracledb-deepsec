import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ClsService, ClsStore } from 'nestjs-cls';
import { DEEPSEC_PUBLIC_ROUTE, DeepSecIdentity } from 'nestjs-oracledb-deepsec';

// App-owned identity shape. Existing apps can keep their own Passport strategy.
export interface DemoUser {
  accessToken: string;
  expiresAt: number;
  username?: string;
  oracleRoles?: string[];
  oracleAttributes?: Record<string, unknown>;
}
export interface DemoAuthStore extends ClsStore {
  user?: DemoUser;
}

@Injectable()
export class AzureSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<DemoAuthStore>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(DEEPSEC_PUBLIC_ROUTE, [
      context.getHandler(), context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user: DemoUser }>();
    // Standard Passport session middleware has already restored/validated the user.
    if (request.headers.authorization !== undefined || !request.isAuthenticated?.()) {
      throw new UnauthorizedException('Sign in required');
    }
    // Bridge authenticated Passport identity into CLS once, before DeepSec mapping.
    // Never return or log this token-bearing identity.
    this.cls.set('user', request.user);
    return true;
  }
}

export function mapDemoIdentity(cls: ClsService<DemoAuthStore>): DeepSecIdentity | null {
  const user = cls.get('user');
  if (!user) return null;
  return {
    endUserToken: user.accessToken,
    dataRoles: user.oracleRoles,
    attributes: user.oracleAttributes,
  };
}
