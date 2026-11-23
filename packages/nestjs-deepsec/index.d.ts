import type { DynamicModule, ExecutionContext, ModuleMetadata, FactoryProvider } from '@nestjs/common';
import type { Pool, PoolAttributes } from 'oracledb';

export interface AzureLoginOptions {
  clientId: string;
  authority: string;
  scopes: string[];
  networkClient?: unknown;
  /** Optional persistent session signing secret. Default is random per process. */
  sessionSecret?: string;
  /** Optional Passport session restoration; the app supplies its serializer. */
  passportSession?: boolean;
  /** An express-session compatible server-side store. Local default is bounded memory. */
  sessionStore?: unknown;
  /** Defaults to true. Set false only for local HTTP development. */
  secureCookie?: boolean;
}

export interface DeepSecIdentity {
  endUserToken: string;
  dataRoles?: string[];
  attributes?: Record<string, unknown>;
}

export interface DeepSecIdentityOptions<TRequest = any> {
  /** Read identity established by the application's authentication guard.
   * This is the only identity source; null/undefined rejects the request.
   * Only map roles/attributes from trusted application policy.
   */
  mapIdentity: (request: TRequest, context: ExecutionContext) =>
    DeepSecIdentity | null | undefined | Promise<DeepSecIdentity | null | undefined>;
  /** Reuse the app's public-route policy. true skips DeepSec, false requires identity.
   * @DeepSecPublic() remains an explicit bypass. Skipped handlers must not do protected DB work.
   */
  isPublic?: (context: ExecutionContext) => boolean | Promise<boolean>;
  /** Optional user-token acquisition for apps without their own sign-in. */
  azureLogin?: AzureLoginOptions;
}

export type DeepSecPoolOptions = PoolAttributes & {
    endUserSecParams: {
      spiType: 'azure';
      authFlow: 'onBehalfOf';
      contextResolution?: 'connection' | 'operation';
      clientId: string;
      clientSecret: string;
      authority: string;
      scopes: string | string[];
      cacheOptions?: { enabled?: boolean; clockSkewMs?: number };
      proxy?: unknown;
      dataRoles?: string[];
      attributes?: Record<string, unknown>;
    };
};

export type DeepSecOptions<TRequest = any> = DeepSecIdentityOptions<TRequest> & (
  /** The adapter creates and closes this pool. */
  { poolOptions: DeepSecPoolOptions; pool?: never } |
  /** The app configures, creates and closes this pool; its existing injection stays unchanged. */
  { pool: Pool; poolOptions?: never }
);

export interface DeepSecAsyncOptions<TRequest = any> {
  /** Explicit opt-in for async-configured Azure login routes. Defaults to false. */
  enableAzureLogin?: boolean;
  imports?: ModuleMetadata['imports'];
  inject?: FactoryProvider['inject'];
  useFactory: (...dependencies: any[]) =>
    DeepSecOptions<TRequest> | Promise<DeepSecOptions<TRequest>>;
}

/** Extract a bearer token only; does not authenticate or authorize the request. */
export declare function mapBearerIdentity(request: { headers?: { authorization?: string } }): DeepSecIdentity | null;
/** Read built-in Azure login's server-side session when passportSession is disabled.
 * Passport apps should map their authenticated request.user or CLS user instead.
 */
export declare function mapSessionIdentity(request: {
  session?: { identity?: { token: string; expiresAt: number } };
}): DeepSecIdentity | null;

/** Optional-login session reader for server-side authentication guards. */
export declare class AzureLoginService {
  /** Returns a token only for a nonexpired authenticated server-side session.
   * Never return this value from an HTTP endpoint or log it.
   */
  tokenForRequest(request: { headers: { cookie?: string } }): string | undefined;
}
/** Metadata key used by @DeepSecPublic(), for authentication-guard integration. */
export declare const DEEPSEC_PUBLIC_ROUTE: unique symbol;
export declare const DEEPSEC_POOL: unique symbol;
export declare function DeepSecPublic(): ClassDecorator & MethodDecorator;
export declare class DeepSecModule {
  static forRoot<TRequest = any>(options: DeepSecOptions<TRequest>): DynamicModule;
  static forRootAsync<TRequest = any>(options: DeepSecAsyncOptions<TRequest>): DynamicModule;
}
