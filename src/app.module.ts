import { Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { AzureSessionStrategy } from './azure-session.strategy';
import { ClsModule, ClsService } from 'nestjs-cls';
import { AzureSessionGuard, DemoAuthStore, mapDemoIdentity } from './azure-session.guard';
import { DeepSecModule } from 'nestjs-oracledb-deepsec';
import { AppController } from './app.controller';
import { DatabaseService } from './database.service';
import { createAzureNetworkClient } from './azure-network';

const required = (name: string) => {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required; see .env.example`);
  return value;
};
const networkClient = createAzureNetworkClient();

@Module({
  imports: [
    PassportModule.register({ session: false }),
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    DeepSecModule.forRootAsync({
      enableAzureLogin: true,
      inject: [ClsService],
      useFactory: (cls: ClsService<DemoAuthStore>) => ({
        mapIdentity: () => mapDemoIdentity(cls),
        // Optional plugin-owned Azure login obtains the user token for this demo.
        azureLogin: {
          clientId: required('AZURE_USER_CLIENT_ID'),
          authority: required('AZURE_USER_AUTHORITY'),
          scopes: required('AZURE_USER_SCOPES').split(/[\s,]+/).filter(Boolean),
          networkClient,
          secureCookie: false, // localhost HTTP only; use true with HTTPS
        },
        poolOptions: {
          user: required('NODE_ORACLEDB_USER'),
          password: required('NODE_ORACLEDB_PASSWORD'),
          connectString: required('NODE_ORACLEDB_CONNECTIONSTRING'),
          walletLocation: process.env.NODE_ORACLEDB_WALLET_LOCATION || undefined,
          walletPassword: process.env.NODE_ORACLEDB_WALLET_PASSWORD || undefined,
          poolMin: 0, poolMax: 4, poolIncrement: 1,
          queueTimeout: 10000, connectTimeout: 10,
          endUserSecParams: {
            spiType: 'azure',
            authFlow: 'onBehalfOf',
            contextResolution: 'connection',
            clientId: required('AZURE_DB_CLIENT_ID'),
            clientSecret: required('AZURE_DB_CLIENT_CREDENTIAL'),
            authority: required('AZURE_DB_AUTHORITY'),
            scopes: required('AZURE_DB_SCOPES').split(/[\s,]+/).filter(Boolean),
            cacheOptions: { enabled: true },
            proxy: networkClient,
          },
        },
      }),
    }),
  ],
  controllers: [AppController],
  providers: [DatabaseService, AzureSessionStrategy,
    { provide: APP_GUARD, useClass: AzureSessionGuard }],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown() { await networkClient?.close(); }
}
