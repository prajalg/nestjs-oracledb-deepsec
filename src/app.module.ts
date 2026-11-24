import { Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AzureAuthModule } from './auth/azure-auth.module';
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
    // Demo-owned sign-in. Existing apps replace this module with their own auth.
    AzureAuthModule.forRoot({
      clientId: required('AZURE_USER_CLIENT_ID'),
      authority: required('AZURE_USER_AUTHORITY'),
      scopes: required('AZURE_USER_SCOPES').split(/[\s,]+/).filter(Boolean),
      networkClient,
      passportSession: true,
      secureCookie: false, // localhost HTTP only; use true with HTTPS
    }),
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    DeepSecModule.forRootAsync({
      inject: [ClsService],
      useFactory: (cls: ClsService<DemoAuthStore>) => ({
        // Called per protected request AFTER the app guard. Pass only identity
        // metadata to the driver; login credentials/session objects stay app-side.
        // Without CLS, use: req => req.user ? { endUserToken: req.user.accessToken } : null
        mapIdentity: () => mapDemoIdentity(cls),
        poolOptions: {
          user: required('NODE_ORACLEDB_USER'),
          password: required('NODE_ORACLEDB_PASSWORD'),
          connectString: required('NODE_ORACLEDB_CONNECTIONSTRING'),
          walletLocation: process.env.NODE_ORACLEDB_WALLET_LOCATION || undefined,
          walletPassword: process.env.NODE_ORACLEDB_WALLET_PASSWORD || undefined,
          poolMin: 0, poolMax: 4, poolIncrement: 1,
          queueTimeout: 10000, connectTimeout: 10,
          // Forwarded unchanged to node-oracledb's SHARED plugin. These are
          // middle-tier/DB exchange credentials, not interactive login settings.
          endUserSecParams: {
            spiType: 'azure',
            authFlow: 'onBehalfOf',
            contextResolution: 'operation',
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
  providers: [DatabaseService,
    { provide: APP_GUARD, useClass: AzureSessionGuard }],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown() { await networkClient?.close(); }
}
