'use strict';
require('reflect-metadata');
const { Module, Injectable, Inject, UnauthorizedException } = require('@nestjs/common');
const { APP_INTERCEPTOR, Reflector } = require('@nestjs/core');
const { Observable } = require('rxjs');
const oracledb = require('oracledb');

// Registers the driver's endUserSecParams configuration hook. No token logic here.
require('oracledb/plugins/token/endUserSecurityProvider');
const contextProvider = oracledb.getSecurityContextProvider();
const { DEEPSEC_POOL, PUBLIC_ROUTE, DeepSecPublic } = require('./tokens');
const { AzureLoginService, AzureLoginController } = require('./azure-login');

class DeepSecInterceptor {
  constructor(reflector, login) { this.reflector = reflector; this.login = login; }

  intercept(context, next) {
    if (context.getType() !== 'http') return next.handle();
    const isPublic = this.reflector.getAllAndOverride(PUBLIC_ROUTE, [
      context.getHandler(), context.getClass(),
    ]);
    if (isPublic) return next.handle();

    const authorization = context.switchToHttp().getRequest().headers.authorization;
    const match = typeof authorization === 'string' && /^Bearer\s+(\S+)$/i.exec(authorization);
    // Explicit bearer credentials take precedence over an optional login session.
    if (authorization !== undefined && !match) throw new UnauthorizedException('Invalid bearer header');
    const token = match ? match[1] : this.login.tokenForRequest(context.switchToHttp().getRequest());
    if (!token) throw new UnauthorizedException('Sign in required');

    // Nest handlers are lazy Observables: subscribe while the async scope is active.
    return new Observable(subscriber => contextProvider.runWithContext(
      { endUserToken: token },
      () => next.handle().subscribe(subscriber),
    ));
  }
}
Injectable()(DeepSecInterceptor);
Inject(Reflector)(DeepSecInterceptor, undefined, 0);
Inject(AzureLoginService)(DeepSecInterceptor, undefined, 1);

class PoolLifecycle {
  constructor(pool) { this.pool = pool; }
  async onApplicationShutdown() { await this.pool.close(10); }
}
Injectable()(PoolLifecycle);
Inject(DEEPSEC_POOL)(PoolLifecycle, undefined, 0);

class DeepSecModule {
  static forRoot(options) {
    if (!options?.poolOptions?.endUserSecParams) {
      throw new TypeError('DeepSecModule requires poolOptions.endUserSecParams');
    }
    return {
      module: DeepSecModule,
      controllers: options.azureLogin ? [AzureLoginController] : [],
      providers: [
        { provide: AzureLoginService, useFactory: () => new AzureLoginService(options.azureLogin) },
        {
          provide: DEEPSEC_POOL,
          useFactory: () => oracledb.createPool(options.poolOptions),
        },
        PoolLifecycle,
        { provide: APP_INTERCEPTOR, useClass: DeepSecInterceptor },
      ],
      exports: [DEEPSEC_POOL],
    };
  }
}
Module({})(DeepSecModule);

module.exports = { DeepSecModule, DeepSecPublic, DEEPSEC_POOL };
