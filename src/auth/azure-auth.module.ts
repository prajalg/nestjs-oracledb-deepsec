import { Module, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AzureSessionSerializer } from '../azure-session.serializer';
import { AzureLoginController, AzureLoginService, type AzureLoginOptions } from './azure-login';

// Authentication belongs to this demo, not to the DeepSec package. This module
// owns its login routes, cookies, MSAL client and optional Passport integration.
@Module({})
export class AzureAuthModule implements NestModule {
  constructor(private readonly login: AzureLoginService) {}

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(...this.login.middlewares).forRoutes('{*path}');
  }

  static forRoot(options: AzureLoginOptions): DynamicModule {
    return {
      module: this,
      imports: options.passportSession ? [PassportModule.register({ session: true })] : [],
      controllers: [AzureLoginController],
      providers: [
        { provide: AzureLoginService, useFactory: () => new AzureLoginService(options) },
        ...(options.passportSession ? [AzureSessionSerializer] : []),
      ],
      exports: [AzureLoginService],
    };
  }
}
