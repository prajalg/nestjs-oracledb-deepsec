import {
  CanActivate, ExecutionContext, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ClsService, ClsStore } from 'nestjs-cls';
import {
  AzureLoginService, DEEPSEC_PUBLIC_ROUTE, DeepSecIdentity,
} from 'nestjs-oracledb-deepsec';

// App-owned authentication. Another app can use Passport and its own user shape.
export interface DemoUser {
  accessToken: string;
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
    private readonly login: AzureLoginService,
    private readonly cls: ClsService<DemoAuthStore>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(DEEPSEC_PUBLIC_ROUTE, [
      context.getHandler(), context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    // This demo authenticates with its opaque session cookie only.
    // A header must not introduce an alternative, unvalidated identity.
    if (request.headers.authorization !== undefined) {
      throw new UnauthorizedException('Use Azure session sign-in');
    }
    const token = this.login.tokenForRequest(request);
    if (!token) throw new UnauthorizedException('Sign in required');

    // The token came from MSAL sign-in and a live server-side session, not a
    // decoded JWT or request body. Do not expose this CLS value through HTTP responses.
    this.cls.set('user', { accessToken: token });
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
