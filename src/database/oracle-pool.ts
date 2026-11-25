import * as oracledb from 'oracledb';
import { azureNetworkClient } from '../auth/azure-network';

export const ORACLE_POOL = Symbol('APP_ORACLE_POOL');

// The application creates and owns this normal Oracle pool.
export function createOraclePool() {
  const options = {
    user: process.env.NODE_ORACLEDB_USER,
    password: process.env.NODE_ORACLEDB_PASSWORD,
    connectString: process.env.NODE_ORACLEDB_CONNECTIONSTRING,
    walletLocation: process.env.NODE_ORACLEDB_WALLET_LOCATION || undefined,
    walletPassword: process.env.NODE_ORACLEDB_WALLET_PASSWORD || undefined,
    connectTimeout: 10,
    poolMin: 0,
    poolMax: 4,
    poolIncrement: 1,
    queueTimeout: 10000,
    // This pool's DeepSec settings; other resources can configure their own.
    endUserSecParams: {
      spiType: 'azure', authFlow: 'onBehalfOf', contextResolution: 'operation',
      clientId: process.env.AZURE_DB_CLIENT_ID,
      clientSecret: process.env.AZURE_DB_CLIENT_CREDENTIAL,
      authority: process.env.AZURE_DB_AUTHORITY,
      scopes: process.env.AZURE_DB_SCOPES!.split(/[\s,]+/).filter(Boolean),
      cacheOptions: { enabled: true }, proxy: azureNetworkClient,
    },
  };
  return oracledb.createPool(options);
}
