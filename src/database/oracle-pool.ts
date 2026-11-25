import * as oracledb from 'oracledb';

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
  };
  return oracledb.createPool(options);
}
