/**
 * Integration examples, type-checked by `npm test`.
 * Keep your existing auth module/guards. Import ONE matching configuration in
 * your app; do not register several DeepSec modules for the same app.
 * These callbacks read identity AFTER authentication; they do not validate JWTs.
 */
import { DeepSecModule, type DeepSecIdentity } from 'nestjs-oracledb-deepsec';
import { ClsService } from 'nestjs-cls'; // Needed only by the CLS example.
import type { Pool } from 'oracledb';

type AppUser = {
  accessToken: string; // Access token accepted by the configured driver exchange.
  oracleRoles?: string[]; // Roles chosen by trusted app policy, not user input.
  oracleAttributes?: Record<string, unknown>;
};
function toOracle(user?: AppUser): DeepSecIdentity | null {
  return user ? { endUserToken: user.accessToken, dataRoles: user.oracleRoles,
    attributes: user.oracleAttributes } : null;
}

// 1. Passport OR any guard that populates request.user. The plugin does not
// import Passport or call request.isAuthenticated(). Your guard rejects invalid auth.
export function withRequestUser(pool: Pool) {
  return DeepSecModule.forRoot<{ user?: AppUser }>({
    pool, // Already created with endUserSecParams; app retains pool shutdown ownership.
    mapIdentity: request => toOracle(request.user),
  });
}

// 2. Custom authentication, no Passport and no CLS. Your existing guard chooses
// its own property name. The access token must be retained by that auth layer.
export function withCustomAuth(pool: Pool) {
  return DeepSecModule.forRoot<{ auth?: { principal?: AppUser } }>({
    pool,
    mapIdentity: request => toOracle(request.auth?.principal),
  });
}

// 3. App-owned server-side sessions. The session middleware verifies the signed
// cookie, and your guard checks identity/expiry. Never map the session ID as a token.
export function withSession(pool: Pool) {
  return DeepSecModule.forRoot<{ session?: { account?: AppUser } }>({
    pool,
    mapIdentity: request => toOracle(request.session?.account),
  });
}

// 4. Existing CLS setup. Initialize CLS before guards; set its user only AFTER
// authentication. Do not capture a user in useFactory: read it inside mapIdentity.
export function withCls(pool: Pool) {
  return DeepSecModule.forRootAsync({
    inject: [ClsService], // Your app already imports/provides its ClsModule.
    useFactory: (cls: ClsService) => ({
      pool,
      mapIdentity: () => toOracle(cls.get<AppUser>('user')),
    }),
  });
}

// 5. Async identity lookup from an app-owned auth service. Inject that service
// with forRootAsync in a real app, then close over it in this per-request callback.
export function withAsyncResolver(pool: Pool, auth: {
  currentUser(request: unknown): Promise<AppUser | undefined>;
}) {
  return DeepSecModule.forRoot({
    pool,
    mapIdentity: async request => toOracle(await auth.currentUser(request)),
  });
}
