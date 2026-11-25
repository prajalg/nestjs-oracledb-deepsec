import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ClsService, ClsStore } from 'nestjs-cls';

// App-owned identity shape. Existing apps can keep their own Passport strategy.
export interface DemoUser {
  accessToken: string;
  expiresAt: number;
  username?: string;
}
export interface DemoAuthStore extends ClsStore {
  user?: DemoUser;
}

@Injectable()
export class AzureSessionGuard implements CanActivate {
  constructor(
    private readonly cls: ClsService<DemoAuthStore>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request & { user: DemoUser }>();
    // Standard Passport session middleware has already restored/validated the user.
    if (request.headers.authorization !== undefined || !request.isAuthenticated?.()) {
      throw new UnauthorizedException('Sign in required');
    }
    // Make the authenticated user available to application code through CLS.
    // Never return or log this token-bearing identity.
    this.cls.set('user', request.user);
    return true;
  }
}
