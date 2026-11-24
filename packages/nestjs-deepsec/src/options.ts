import type { ExecutionContext, ModuleMetadata, FactoryProvider } from '@nestjs/common';
import type { Pool, PoolAttributes } from 'oracledb';

export interface DeepSecIdentity {
  endUserToken: string;
  dataRoles?: string[];
  attributes?: Record<string, unknown>;
}

export interface DeepSecIdentityOptions<TRequest = any> {
  /** Read identity established by the application's authentication guard.
   * This is the only identity source; null/undefined rejects the request.
   * Runs AFTER Nest authentication guards, once per protected HTTP request.
   * Read request.user, your own request property, or injected request-local storage.
   * Supply an access token suitable for the configured driver exchange, not a
   * session ID, username or ID token. Never authenticate by merely decoding a JWT.
   * Only map roles/attributes from trusted application policy.
   */
  mapIdentity: (request: TRequest, context: ExecutionContext) =>
    DeepSecIdentity | null | undefined | Promise<DeepSecIdentity | null | undefined>;
  /** Reuse the app's public-route policy. true skips DeepSec, false requires identity.
   * @DeepSecPublic() remains an explicit bypass. Skipped handlers must not do protected DB work.
   */
  isPublic?: (context: ExecutionContext) => boolean | Promise<boolean>;
}

/** Driver configuration is forwarded unchanged; the shared driver validates its
 * provider-specific settings. The adapter does not choose Azure/OCI or acquire tokens.
 */
export type DeepSecPoolOptions = PoolAttributes & {
  endUserSecParams: {
    contextResolution?: 'connection' | 'operation';
    [driverOption: string]: unknown;
  };
};

export type DeepSecOptions<TRequest = any> = DeepSecIdentityOptions<TRequest> & (
  /** The adapter creates and closes this pool. */
  { poolOptions: DeepSecPoolOptions; pool?: never } |
  /** The app configures, creates and closes this pool; its existing injection stays unchanged. */
  { pool: Pool; poolOptions?: never }
);

export interface DeepSecAsyncOptions<TRequest = any> {
  imports?: ModuleMetadata['imports'];
  inject?: FactoryProvider['inject'];
  useFactory: (...dependencies: any[]) =>
    DeepSecOptions<TRequest> | Promise<DeepSecOptions<TRequest>>;
}

