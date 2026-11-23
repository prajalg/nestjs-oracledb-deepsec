import type { DynamicModule } from '@nestjs/common';
import type { PoolAttributes } from 'oracledb';

export interface AzureLoginOptions {
  clientId: string;
  authority: string;
  scopes: string[];
  networkClient?: unknown;
  /** Defaults to true. Set false only for local HTTP development. */
  secureCookie?: boolean;
}

export interface DeepSecOptions {
  /** Optional user-token acquisition for apps without their own sign-in. */
  azureLogin?: AzureLoginOptions;
  poolOptions: PoolAttributes & {
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
}
export declare const DEEPSEC_POOL: unique symbol;
export declare function DeepSecPublic(): ClassDecorator & MethodDecorator;
export declare class DeepSecModule {
  static forRoot(options: DeepSecOptions): DynamicModule;
}
