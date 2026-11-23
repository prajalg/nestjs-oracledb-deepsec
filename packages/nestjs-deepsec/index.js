'use strict';
require('reflect-metadata');
const { Module, Injectable, Inject, UnauthorizedException, ConfigurableModuleBuilder } = require('@nestjs/common');
const { APP_INTERCEPTOR, Reflector } = require('@nestjs/core');
const { Observable } = require('rxjs');
const oracledb = require('oracledb');

// Registers the driver's endUserSecParams configuration hook. No token logic here.
require('oracledb/plugins/token/endUserSecurityProvider');
const contextProvider = oracledb.getSecurityContextProvider();
const { DEEPSEC_POOL, PUBLIC_ROUTE, DeepSecPublic } = require('./tokens');
const { AzureLoginService, AzureLoginController } = require('./azure-login');
const { mapBearerIdentity, mapSessionIdentity } = require('./identity-mappers');
const OPTIONS = Symbol('DEEPSEC_OPTIONS');
const RAW_OPTIONS = Symbol('DEEPSEC_RAW_OPTIONS');

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
  constructor(reflector, options) {
    this.reflector = reflector;
    this.mapIdentity = options.mapIdentity;
    this.isPublic = options.isPublic;
  }

  async intercept(context, next) {
    if (context.getType() !== 'http') return next.handle();
    let isPublic = this.reflector.getAllAndOverride(PUBLIC_ROUTE, [
      context.getHandler(), context.getClass(),
    ]);
    if (isPublic !== true && this.isPublic) {
      isPublic = await this.isPublic(context);
      if (typeof isPublic !== 'boolean') throw new TypeError('isPublic must return a boolean');
    }
    if (isPublic === true) return next.handle();

    const request = context.switchToHttp().getRequest();
    // Authentication belongs to the app; this callback is the only identity source.
    const metadata = snapshotIdentity(await this.mapIdentity(request, context));

    // Nest handlers are lazy Observables: subscribe while the async scope is active.
    return new Observable(subscriber => contextProvider.runWithContext(
      metadata,
      () => next.handle().subscribe(subscriber),
    ));
  }
}
Injectable()(DeepSecInterceptor);
Inject(Reflector)(DeepSecInterceptor, undefined, 0);
Inject(OPTIONS)(DeepSecInterceptor, undefined, 1);

class PoolLifecycle {
  constructor(pool, options) { this.pool = pool; this.ownsPool = options.poolOptions !== undefined; }
  async onApplicationShutdown() {
    // A borrowed application pool keeps its existing owner and shutdown lifecycle.
    if (this.ownsPool) await this.pool.close(10);
  }
}
Injectable()(PoolLifecycle);
Inject(DEEPSEC_POOL)(PoolLifecycle, undefined, 0);
Inject(OPTIONS)(PoolLifecycle, undefined, 1);

function validateOptions(options, enableAzureLogin) {
  const hasPool = options?.pool !== undefined;
  const hasPoolOptions = options?.poolOptions !== undefined;
  if (hasPool === hasPoolOptions) {
    throw new TypeError('DeepSecModule requires exactly one of pool or poolOptions');
  }
  if (hasPool && (!options.pool || typeof options.pool.getConnection !== 'function' ||
      typeof options.pool.close !== 'function')) {
    throw new TypeError('DeepSecModule pool must be an existing configured Oracle pool');
  }
  if (hasPoolOptions && !options.poolOptions?.endUserSecParams) {
    throw new TypeError('DeepSecModule requires poolOptions.endUserSecParams');
  }
  if (typeof options.mapIdentity !== 'function') {
    throw new TypeError('DeepSecModule requires a mapIdentity function');
  }
  if (options.isPublic !== undefined && typeof options.isPublic !== 'function') {
    throw new TypeError('DeepSecModule isPublic must be a function');
  }
  if (options.azureLogin && !enableAzureLogin) {
    throw new TypeError('Set enableAzureLogin: true in forRootAsync to register Azure login routes');
  }
  if (enableAzureLogin && !options.azureLogin) {
    throw new TypeError('Azure login routes require azureLogin configuration');
  }
  return options;
}

function createModule(definition, enableAzureLogin) {
  return {
    ...definition,
    controllers: enableAzureLogin ? [AzureLoginController] : [],
    providers: [
      ...definition.providers,
      { provide: OPTIONS, inject: [RAW_OPTIONS],
        useFactory: options => validateOptions(options, enableAzureLogin) },
      { provide: AzureLoginService, inject: [OPTIONS],
        useFactory: config => new AzureLoginService(config.azureLogin) },
      { provide: DEEPSEC_POOL, inject: [OPTIONS],
        useFactory: config => config.pool ?? oracledb.createPool(config.poolOptions) },
      PoolLifecycle,
      { provide: APP_INTERCEPTOR, useClass: DeepSecInterceptor },
    ],
    exports: [DEEPSEC_POOL, AzureLoginService],
  };
}

// Nest owns async configuration, imports and dependency-injection plumbing.
const { ConfigurableModuleClass } = new ConfigurableModuleBuilder({ optionsInjectionToken: RAW_OPTIONS })
  .setClassMethodName('forRoot')
  .setExtras({ enableAzureLogin: false }, (definition, extras) =>
    createModule(definition, extras.enableAzureLogin))
  .build();

class DeepSecModule extends ConfigurableModuleClass {
  constructor(login) { super(); this.login = login; }

  configure(consumer) {
    if (this.login.middleware) consumer.apply(...this.login.middlewares).forRoutes('{*path}');
  }

  static forRoot(options) {
    const enableAzureLogin = Boolean(options?.azureLogin);
    validateOptions(options, enableAzureLogin);
    return super.forRoot({ ...options, enableAzureLogin });
  }

  static forRootAsync(options) {
    if (typeof options?.useFactory !== 'function') {
      throw new TypeError('DeepSecModule.forRootAsync requires useFactory');
    }
    if (options.enableAzureLogin !== undefined && typeof options.enableAzureLogin !== 'boolean') {
      throw new TypeError('enableAzureLogin must be a boolean');
    }
    return super.forRootAsync(options);
  }
}
Inject(AzureLoginService)(DeepSecModule, undefined, 0);
Module({})(DeepSecModule);

module.exports = {
  DeepSecModule, DeepSecPublic, DEEPSEC_POOL, AzureLoginService,
  mapBearerIdentity, mapSessionIdentity,
  DEEPSEC_PUBLIC_ROUTE: PUBLIC_ROUTE,
};
