import 'reflect-metadata';
import { Module, UnauthorizedException, ConfigurableModuleBuilder, type NestInterceptor } from '@nestjs/common';
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

@Module({
  providers: [{
    provide: APP_INTERCEPTOR,
    inject: [Reflector, MODULE_OPTIONS_TOKEN],
    useFactory: (reflector: Reflector, options: DeepSecOptions): NestInterceptor => {
      if (typeof options?.mapIdentity !== 'function') throw new TypeError('DeepSecModule requires a mapIdentity function');
      return {
        async intercept(context, next) {
          if (context.getType() !== 'http') return next.handle();
          const scope = reflector.getAllAndOverride<false | DeepSecScopeOptions>(SCOPE,
            [context.getHandler(), context.getClass()]);
          if (scope === false) return next.handle();

          const mappedIdentity = await options.mapIdentity(context.switchToHttp().getRequest(), context);
          if (mappedIdentity == null) throw new UnauthorizedException('A mapped end-user identity is required');
          // Copy only defined fields, preserving resource defaults and the app's identity.
          const metadata: DeepSecIdentity = { endUserToken: mappedIdentity.endUserToken };
          const dataRoles = scope?.dataRoles ?? mappedIdentity.dataRoles;
          if (dataRoles !== undefined) metadata.dataRoles = [...dataRoles];
          if (mappedIdentity.attributes !== undefined) metadata.attributes = structuredClone(mappedIdentity.attributes);

          // Nest handlers are lazy: subscribe within the scope and preserve teardown.
          return new Observable(subscriber => securityContextProvider.runWithContext(metadata,
            () => next.handle().subscribe(subscriber)));
        },
      };
    },
  }],
})
export class DeepSecModule extends ConfigurableModuleClass {}
