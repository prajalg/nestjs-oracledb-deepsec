import { Module, Inject, OnApplicationShutdown } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import type { Pool } from 'oracledb';
import { AzureAuthModule } from './auth/azure-auth.module';
import { AzureSessionGuard } from './auth/azure-session.guard';
import { azureNetworkClient as networkClient } from './auth/azure-network';
import { ORACLE_POOL, createOraclePool } from './database/oracle-pool';
import { StandaloneController } from './database/standalone.controller';
import { StandaloneService } from './database/standalone.service';
import { EmployeesController } from './employees/employees.controller';
import { EmployeesService } from './employees/employees.service';
import { HealthController } from './health.controller';

const required = (name: string) => {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required; see .env.example`);
  return value;
};

@Module({
  imports: [
    AzureAuthModule.forRoot({
      clientId: required('AZURE_USER_CLIENT_ID'),
      authority: required('AZURE_USER_AUTHORITY'),
      scopes: required('AZURE_USER_SCOPES').split(/[\s,]+/).filter(Boolean),
      networkClient,
      passportSession: true,
      secureCookie: false, // Local HTTP only; use true with HTTPS.
    }),
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
  ],
  controllers: [EmployeesController, StandaloneController, HealthController],
  providers: [
    { provide: ORACLE_POOL, useFactory: createOraclePool },
    EmployeesService, StandaloneService, AzureSessionGuard,
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(ORACLE_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown() {
    try { await this.pool.close(10); }
    finally { await networkClient?.close(); }
  }
}
