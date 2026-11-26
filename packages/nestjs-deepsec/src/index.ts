import 'reflect-metadata';
import { Module, Injectable, Inject, ConfigurableModuleBuilder, type NestInterceptor, type ExecutionContext, type CallHandler } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import type { DeepSecOptions, DeepSecIdentity, DeepSecScopeOptions } from './options';
import { SCOPE } from './tokens';
import 'oracledb/plugins/token/endUserSecurityProvider';

export type * from './options';
export { DeepSec, SkipDeepSec } from './tokens';

// Type the driver boundary because its declarations do not yet expose this API.
const securityContextProvider: {
  runWithContext<T>(metadata: DeepSecIdentity, callback: () => T): T;
} = require('oracledb').getSecurityContextProvider();
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<DeepSecOptions>()
  .setClassMethodName('forRoot').build();

// Gateways need an explicit @UseInterceptors(DeepSecInterceptor) registration;
// HTTP and microservice handlers use the global APP_INTERCEPTOR registration.
@Injectable()
export class DeepSecInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: DeepSecOptions) {
    if (typeof options?.mapIdentity !== 'function') throw new TypeError('DeepSecModule requires a mapIdentity function');
  }

  async intercept(context: ExecutionContext, next: CallHandler) {
    const scope = this.reflector.getAllAndOverride<false | DeepSecScopeOptions>(SCOPE,
      [context.getHandler(), context.getClass()]);
    if (scope === false) return next.handle();

    const mappedIdentity = await this.options.mapIdentity(context);
    if (mappedIdentity == null) throw new Error('A mapped end-user identity is required');
    // Copy only defined fields, preserving resource defaults and the app's identity.
    const metadata: DeepSecIdentity = { endUserToken: mappedIdentity.endUserToken };
    const dataRoles = scope?.dataRoles ?? mappedIdentity.dataRoles;
    if (dataRoles !== undefined) metadata.dataRoles = [...dataRoles];
    if (mappedIdentity.attributes !== undefined) metadata.attributes = structuredClone(mappedIdentity.attributes);

    // Nest handlers are lazy: subscribe within the scope and preserve teardown.
    return new Observable(subscriber => securityContextProvider.runWithContext(metadata,
      () => next.handle().subscribe(subscriber)));
  }
}

@Module({
  providers: [DeepSecInterceptor, { provide: APP_INTERCEPTOR, useExisting: DeepSecInterceptor }],
  // Export options for Nest to resolve a gateway-local interceptor instance.
  exports: [DeepSecInterceptor, MODULE_OPTIONS_TOKEN],
})
export class DeepSecModule extends ConfigurableModuleClass {}
