import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import type { Request } from 'express';
import { AzureLoginService } from 'nestjs-oracledb-deepsec';
import type { DemoUser } from './azure-session.guard';

// Passport authenticates the same server-side Azure session as the demo used
// before. It does not introduce another cookie store or a username/password flow.
@Injectable()
export class AzureSessionStrategy extends PassportStrategy(Strategy, 'azure-session') {
  constructor(private readonly login: AzureLoginService) { super(); }

  validate(request: Request): DemoUser {
    // Only the opaque session cookie authenticates this demo. Raw bearer tokens
    // are not validated by this strategy and must not act as a fallback.
    if (request.headers.authorization !== undefined) {
      throw new UnauthorizedException('Use Azure session sign-in');
    }
    const token = this.login.tokenForRequest(request);
    if (!token) throw new UnauthorizedException('Sign in required');
    return { accessToken: token };
  }
}
