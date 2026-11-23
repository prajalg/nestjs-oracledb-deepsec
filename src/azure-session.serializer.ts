import { Injectable } from '@nestjs/common';
import { PassportSerializer } from '@nestjs/passport';
import type { DemoUser } from './azure-session.guard';

type Done = (error: Error | null, user?: DemoUser | false) => void;

@Injectable()
export class AzureSessionSerializer extends PassportSerializer {
  serializeUser(user: DemoUser, done: Done) {
    // express-session stores this server-side; the browser receives only its ID.
    done(null, { accessToken: user.accessToken, expiresAt: user.expiresAt, username: user.username });
  }

  deserializeUser(user: DemoUser, done: Done) {
    const valid = user && typeof user.accessToken === 'string' && user.accessToken.trim() &&
      Number.isFinite(user.expiresAt) && user.expiresAt > Date.now();
    done(null, valid ? user : false);
  }
}
