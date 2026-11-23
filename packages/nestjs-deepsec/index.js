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
const IDENTITY_MAPPER = Symbol('DEEPSEC_IDENTITY_MAPPER');

function snapshotIdentity(identity) {
  if (!identity || typeof identity.endUserToken !== 'string' || !identity.endUserToken.trim() ||
      (identity.dataRoles !== undefined && (!Array.isArray(identity.dataRoles) ||
        !identity.dataRoles.every(role => typeof role === 'string' && role.trim()))) ||
      (identity.attributes !== undefined && (!identity.attributes ||
        typeof identity.attributes !== 'object' || Array.isArray(identity.attributes)))) {
    throw new UnauthorizedException('A mapped end-user identity is required');
  }
  try {
    // Copy only supported metadata. Later mutations to req.user cannot change this scope.
    return {
      endUserToken: identity.endUserToken,
      ...(identity.dataRoles !== undefined && { dataRoles: [...identity.dataRoles] }),
      ...(identity.attributes !== undefined && {
        attributes: JSON.parse(JSON.stringify(identity.attributes)),
      }),
    };
  } catch {
    throw new UnauthorizedException('Invalid identity metadata');
  }
}

class DeepSecInterceptor {
  constructor(reflector, login, mapIdentity) {
    this.reflector = reflector; this.login = login; this.mapIdentity = mapIdentity;
  }

  async intercept(context, next) {
    if (context.getType() !== 'http') return next.handle();
    const isPublic = this.reflector.getAllAndOverride(PUBLIC_ROUTE, [
      context.getHandler(), context.getClass(),
    ]);
    if (isPublic) return next.handle();

    const request = context.switchToHttp().getRequest();
    let metadata;
    if (this.mapIdentity) {
      // Authentication guards run first. The mapper is authoritative: never fall
      // back to a raw header or demo session when the authenticated identity is absent.
      metadata = snapshotIdentity(await this.mapIdentity(request, context));
    } else {
      const authorization = request.headers.authorization;
      const match = typeof authorization === 'string' && /^Bearer\s+(\S+)$/i.exec(authorization);
      // Compatibility path: Azure validates a forwarded bearer token during OBO.
      if (authorization !== undefined && !match) throw new UnauthorizedException('Invalid bearer header');
      const token = match ? match[1] : this.login.tokenForRequest(request);
      if (!token) throw new UnauthorizedException('Sign in required');
      metadata = { endUserToken: token };
    }

    // Nest handlers are lazy Observables: subscribe while the async scope is active.
    return new Observable(subscriber => contextProvider.runWithContext(
      metadata,
      () => next.handle().subscribe(subscriber),
    ));
  }
}
Injectable()(DeepSecInterceptor);
Inject(Reflector)(DeepSecInterceptor, undefined, 0);
Inject(AzureLoginService)(DeepSecInterceptor, undefined, 1);
Inject(IDENTITY_MAPPER)(DeepSecInterceptor, undefined, 2);

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
    if (options.mapIdentity !== undefined && typeof options.mapIdentity !== 'function') {
      throw new TypeError('DeepSecModule mapIdentity must be a function');
    }
    return {
      module: DeepSecModule,
      controllers: options.azureLogin ? [AzureLoginController] : [],
      providers: [
        { provide: IDENTITY_MAPPER, useValue: options.mapIdentity ?? null },
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
