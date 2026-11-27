import 'reflect-metadata';
import { Module, Injectable, Inject, ConfigurableModuleBuilder, type NestInterceptor, type ExecutionContext, type CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import 'oracledb/plugins/token/endUserSecurityProvider';

import type { DeepSecIdentity, DeepSecOptions } from './deepsec.definitions';
import { SKIP_DEEPSEC, DATA_ROLES } from './deepsec.definitions';
export type * from './deepsec.definitions';
export { RunWithDataRoles, SkipDeepSec } from './deepsec.definitions';

// Get the driver's API for running code with the current user's identity.
const securityContextProvider: {
  runWithContext<T>(metadata: DeepSecIdentity, callback: () => T): T;
} = require('oracledb').getSecurityContextProvider();

// Generate forRoot()/forRootAsync() and the token (lookup key) used to inject the app's options.
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<DeepSecOptions>()
  .setClassMethodName('forRoot').build();

// Attach DeepSec interceptor with @UseInterceptors(DeepSecInterceptor), or let the app register
// APP_INTERCEPTOR with useExisting: DeepSecInterceptor for global interception.
@Injectable()
export class DeepSecInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: DeepSecOptions) {
    if (typeof options?.mapIdentity !== 'function') throw new TypeError('DeepSecConfiguration requires a mapIdentity function');
  }

  async intercept(context: ExecutionContext, next: CallHandler) {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_DEEPSEC, targets)) return next.handle();

    // Read the app's authenticated user and return the identity metadata needed by DeepSec.
    const mappedIdentity = await this.options.mapIdentity(context);
    if (mappedIdentity == null)
      throw new Error('A mapped end-user identity is required');
    const metadata: DeepSecIdentity = { endUserToken: mappedIdentity.endUserToken };
    const dataRoles = this.reflector.getAllAndOverride<readonly string[]>(DATA_ROLES, targets) ?? mappedIdentity.dataRoles;
    if (dataRoles !== undefined) metadata.dataRoles = [...dataRoles];
    if (mappedIdentity.attributes !== undefined) metadata.attributes = structuredClone(mappedIdentity.attributes);

    // Return a wrapper that runs the handler and its queries with this user's DeepSec identity.
    return new Observable(subscriber => securityContextProvider.runWithContext(metadata,
      () => next.handle().subscribe(subscriber)));
  }
}

@Module({
  providers: [DeepSecInterceptor],
  exports: [DeepSecInterceptor, MODULE_OPTIONS_TOKEN],
})
export class DeepSecConfiguration extends ConfigurableModuleClass {}
