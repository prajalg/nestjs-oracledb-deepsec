import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import * as oracledb from 'oracledb';
import { performance } from 'node:perf_hooks';
import { oracleConnectionOptions } from './oracle-options';
import { errorDetails } from '../shared/error-details';

export const STANDALONE_QUERY = `SELECT SYSTIMESTAMP AS DATABASE_TIME,
  SYS_CONTEXT('USERENV', 'SESSION_USER') AS SESSION_USER
FROM dual`;

@Injectable()
export class StandaloneService {
  async runQuery() {
    const started = performance.now();
    let connection: oracledb.Connection | undefined;
    try {
      // The app still opens and closes its own standalone connection.
      connection = await oracledb.getConnection(oracleConnectionOptions());
      connection.callTimeout = 15000;
      const result = await connection.execute(STANDALONE_QUERY, [], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return {
        durationMs: Math.round(performance.now() - started),
        columns: result.metaData?.map(column => column.name) ?? [],
        rows: result.rows ?? [],
        sql: STANDALONE_QUERY,
      };
    } catch (error) {
      throw new ServiceUnavailableException({
        code: 'DATABASE_UNAVAILABLE', ...errorDetails(error, 'Oracle query failed'),
      });
    } finally {
      if (connection) {
        await connection.close().catch(() => {
          console.error('Oracle standalone connection release failed.');
        });
      }
    }
  }
}
