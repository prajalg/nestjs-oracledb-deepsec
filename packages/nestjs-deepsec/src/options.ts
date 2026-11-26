import type { ExecutionContext } from '@nestjs/common';

export interface DeepSecIdentity {
  endUserToken: string;
  dataRoles?: string[];
  attributes?: Record<string, unknown>;
}

export interface DeepSecScopeOptions {
  /** Replace mapped roles for this scope only. Oracle must authorize their use. */
  dataRoles?: readonly string[];
}

export interface DeepSecOptions {
  /** Called per handler execution after guards. Use ExecutionContext to read the
   * app's trusted HTTP, WebSocket, RPC or GraphQL identity, or read app-owned CLS.
   * Login, token/role/attribute validation and token renewal stay app-owned.
   * Return null to reject execution; throw an app/transport-specific exception
   * for a custom response. Supply JSON-compatible attributes.
   */
  mapIdentity: (context: ExecutionContext) =>
    DeepSecIdentity | null | undefined | Promise<DeepSecIdentity | null | undefined>;
}
