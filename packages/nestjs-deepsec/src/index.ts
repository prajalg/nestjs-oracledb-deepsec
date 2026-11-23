import 'reflect-metadata';
import { Module, Injectable, Inject, UnauthorizedException, ConfigurableModuleBuilder,
  type DynamicModule, type ExecutionContext, type CallHandler, type NestInterceptor,
  type MiddlewareConsumer, type NestModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import * as oracledb from 'oracledb';
import type { DeepSecOptions, DeepSecAsyncOptions, DeepSecIdentity } from './options';
import { DEEPSEC_POOL, PUBLIC_ROUTE } from './tokens';
import { AzureLoginService, AzureLoginController } from './azure-login';

// Register the shared driver hook. The installed driver types do not yet expose
// its context API; keep this compatibility type at the driver boundary only.
import 'oracledb/plugins/token/endUserSecurityProvider';
const contextProvider = (oracledb as typeof oracledb & {
  getSecurityContextProvider(): {
    runWithContext<T>(metadata: DeepSecIdentity, callback: () => T): T;
  };
}).getSecurityContextProvider();

export type * from './options';
export { DeepSecPublic, DEEPSEC_POOL, PUBLIC_ROUTE as DEEPSEC_PUBLIC_ROUTE } from './tokens';
export { AzureLoginService } from './azure-login';
export { mapBearerIdentity, mapSessionIdentity } from './identity-mappers';

const OPTIONS = Symbol('DEEPSEC_OPTIONS');
const RAW_OPTIONS = Symbol('DEEPSEC_RAW_OPTIONS');

function snapshotIdentity(identity: DeepSecIdentity | null | undefined): DeepSecIdentity {
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

@Injectable()
class DeepSecInterceptor implements NestInterceptor {
  private readonly mapIdentity: DeepSecOptions['mapIdentity'];
  private readonly isPublic: DeepSecOptions['isPublic'];

  constructor(private readonly reflector: Reflector, @Inject(OPTIONS) options: DeepSecOptions) {
    this.mapIdentity = options.mapIdentity;
    this.isPublic = options.isPublic;
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    let isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
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
@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  private readonly ownsPool: boolean;
  constructor(@Inject(DEEPSEC_POOL) private readonly pool: oracledb.Pool,
    @Inject(OPTIONS) options: DeepSecOptions) {
    this.ownsPool = options.poolOptions !== undefined;
  }
  async onApplicationShutdown() {
    // A borrowed pool keeps its application-owned shutdown lifecycle.
    if (this.ownsPool) await this.pool.close(10);
  }
}

function validateOptions(options: DeepSecOptions, enableAzureLogin: boolean): DeepSecOptions {
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

function createModule(definition: DynamicModule, enableAzureLogin: boolean): DynamicModule {
  return {
    ...definition,
    controllers: enableAzureLogin ? [AzureLoginController] : [],
    providers: [
      ...(definition.providers ?? []),
      { provide: OPTIONS, inject: [RAW_OPTIONS],
        useFactory: (options: DeepSecOptions) => validateOptions(options, enableAzureLogin) },
      { provide: AzureLoginService, inject: [OPTIONS],
        useFactory: (config: DeepSecOptions) => new AzureLoginService(config.azureLogin) },
      { provide: DEEPSEC_POOL, inject: [OPTIONS],
        useFactory: (config: DeepSecOptions) => config.pool ?? oracledb.createPool(config.poolOptions) },
      PoolLifecycle,
      { provide: APP_INTERCEPTOR, useClass: DeepSecInterceptor },
    ],
    exports: [DEEPSEC_POOL, AzureLoginService],
  };
}

// Nest owns async configuration, imports and dependency-injection plumbing.
const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<DeepSecOptions>({ optionsInjectionToken: RAW_OPTIONS })
  .setClassMethodName('forRoot')
  .setExtras({ enableAzureLogin: false }, (definition, extras) =>
    createModule(definition, extras.enableAzureLogin))
  .build();

@Module({})
export class DeepSecModule implements NestModule {
  constructor(private readonly login: AzureLoginService) {}

  configure(consumer: MiddlewareConsumer) {
    if (this.login.middleware) consumer.apply(...this.login.middlewares).forRoutes('{*path}');
  }

  static forRoot<TRequest = any>(options: DeepSecOptions<TRequest>): DynamicModule {
    const enableAzureLogin = Boolean(options?.azureLogin);
    validateOptions(options, enableAzureLogin);
    return { ...ConfigurableModuleClass.forRoot({ ...options, enableAzureLogin }), module: this };
  }

  static forRootAsync<TRequest = any>(options: DeepSecAsyncOptions<TRequest>): DynamicModule {
    if (typeof options?.useFactory !== 'function') {
      throw new TypeError('DeepSecModule.forRootAsync requires useFactory');
    }
    if (options.enableAzureLogin !== undefined && typeof options.enableAzureLogin !== 'boolean') {
      throw new TypeError('enableAzureLogin must be a boolean');
    }
    return { ...ConfigurableModuleClass.forRootAsync(options), module: this };
  }
}
