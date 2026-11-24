import 'reflect-metadata';
import { Module, Injectable, Inject, UnauthorizedException, ConfigurableModuleBuilder,
  type DynamicModule, type ExecutionContext, type CallHandler, type NestInterceptor,
  type OnApplicationShutdown } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import * as oracledb from 'oracledb';
import type { DeepSecOptions, DeepSecAsyncOptions, DeepSecIdentity } from './options';
import { DEEPSEC_POOL, PUBLIC_ROUTE } from './tokens';

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
    // Developer integration point: your guard has already authenticated the request.
    // mapIdentity translates its trusted user/token shape; no Passport, CLS,
    // header or session convention is assumed here. A null result fails closed.
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

function validateOptions(options: DeepSecOptions): DeepSecOptions {
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
  return options;
}

function createModule(definition: DynamicModule): DynamicModule {
  return {
    ...definition,
    providers: [
      ...(definition.providers ?? []),
      { provide: OPTIONS, inject: [RAW_OPTIONS],
        useFactory: (options: DeepSecOptions) => validateOptions(options) },
      { provide: DEEPSEC_POOL, inject: [OPTIONS],
        useFactory: (config: DeepSecOptions) => config.pool ?? oracledb.createPool(config.poolOptions) },
      PoolLifecycle,
      { provide: APP_INTERCEPTOR, useClass: DeepSecInterceptor },
    ],
    exports: [DEEPSEC_POOL],
  };
}

// Nest owns async configuration, imports and dependency-injection plumbing.
const { ConfigurableModuleClass } = new ConfigurableModuleBuilder<DeepSecOptions>({ optionsInjectionToken: RAW_OPTIONS })
  .setClassMethodName('forRoot')
  .setExtras({}, definition => createModule(definition))
  .build();

@Module({})
export class DeepSecModule {
  static forRoot<TRequest = any>(options: DeepSecOptions<TRequest>): DynamicModule {
    validateOptions(options);
    return { ...ConfigurableModuleClass.forRoot(options), module: this };
  }

  static forRootAsync<TRequest = any>(options: DeepSecAsyncOptions<TRequest>): DynamicModule {
    if (typeof options?.useFactory !== 'function') {
      throw new TypeError('DeepSecModule.forRootAsync requires useFactory');
    }
    return { ...ConfigurableModuleClass.forRootAsync(options), module: this };
  }
}
