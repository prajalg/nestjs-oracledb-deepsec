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

export interface DeepSecOptions<TRequest = any> {
  /** Called once per HTTP request after guards. Read the app's trusted identity
   * from request.user, a server session or an injected request-local service.
   * Login, token/role/attribute validation and token renewal stay app-owned.
   * Return null to reject a request; supply JSON-compatible attributes.
   */
  mapIdentity: (request: TRequest, context: ExecutionContext) =>
    DeepSecIdentity | null | undefined | Promise<DeepSecIdentity | null | undefined>;
}
