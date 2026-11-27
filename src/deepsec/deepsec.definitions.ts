import { SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

export interface DeepSecIdentity {
  endUserToken: string;
  dataRoles?: string[];
  attributes?: Record<string, unknown>;
}

export interface DeepSecOptions {
  /**
   * Read the app's authenticated user and return endUserToken, optional dataRoles
   * and JSON-compatible attributes.
   *
   * Runs once per intercepted handler execution, after guards,
   * unless SkipDeepSec applies.
   * Use the execution context or app-owned CLS; authentication and token renewal
   * remain the app's responsibility. May return a Promise. Returning null/undefined
   * rejects execution before the handler runs.
   *
   * @example
   * mapIdentity: context => {
   *   const user = context.switchToHttp().getRequest().user;
   *   return user ? { endUserToken: user.accessToken } : null;
   * }
   */
  mapIdentity: (context: ExecutionContext) =>
    DeepSecIdentity | null | undefined | Promise<DeepSecIdentity | null | undefined>;
}

export const SKIP_DEEPSEC = Symbol('SKIP_DEEPSEC');
export const DATA_ROLES = Symbol('DEEPSEC_DATA_ROLES');

/**
 * Use this decorator when a handler needs different roles from those returned
 * by mapIdentity. Pass the role names above the handler; no changes to the
 * shared mapper or query code are needed. Can also be applied to a controller.
 *
 * Replaces roles rather than adding to them. Handler roles override controller
 * roles; [] clears roles. Requires DeepSec interception and does not override
 * SkipDeepSec. Oracle must authorize the roles; do not take them from user input.
 *
 * @example ```@RunWithDataRoles(['SALARY_REPORT'])```
 */
export const RunWithDataRoles = (roles: readonly string[]): ClassDecorator & MethodDecorator =>
  SetMetadata(DATA_ROLES, [...roles]);

/**
 * Bypasses this interceptor's identity mapping and DeepSec wrapper.
 * On a handler, skips that handler; on a controller, skips all its handlers.
 * ```RunWithDataRoles``` cannot override this skip.
 *
 * Skips this interceptor's identity setup; does not remove an existing driver context.
 *
 * @example ```@SkipDeepSec()```
 */
export const SkipDeepSec = (): ClassDecorator & MethodDecorator => SetMetadata(SKIP_DEEPSEC, true);
