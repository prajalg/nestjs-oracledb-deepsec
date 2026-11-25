import * as oracledb from 'oracledb';
import { oracleConnectionOptions } from './oracle-options';

export const ORACLE_POOL = Symbol('APP_ORACLE_POOL');

// The application creates and owns this normal Oracle pool.
export function createOraclePool() {
  const options = {
    ...oracleConnectionOptions(),
    poolMin: 0,
    poolMax: 4,
    poolIncrement: 1,
    queueTimeout: 10000,
  };
  return oracledb.createPool(options);
}
