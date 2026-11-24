import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import * as oracledb from 'oracledb';
import { DEEPSEC_POOL } from 'nestjs-oracledb-deepsec';
import { performance } from 'node:perf_hooks';
import { errorDetails } from './error-details';

export const DEMO_QUERY = `SELECT *
FROM hr.employees
ORDER BY employee_id
FETCH FIRST 100 ROWS ONLY`;

@Injectable()
export class DatabaseService {
  constructor(@Inject(DEEPSEC_POOL) private readonly pool: oracledb.Pool) {}

  async runQuery() {
    const started = performance.now();
    let connection: oracledb.Connection | undefined;
    try {
      if (!this.pool) throw new Error('Pool is not initialized');
      connection = await this.pool.getConnection();
      connection.callTimeout = 15000;
      const result = await connection.execute(DEMO_QUERY, [], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return {
        connected: true,
        driverMode: oracledb.thin ? 'Thin' : 'Thick',
        databaseVersion: connection.oracleServerVersionString,
        durationMs: Math.round(performance.now() - started),
        columns: result.metaData?.map(column => column.name) ?? [],
        rows: result.rows ?? [],
        sql: DEMO_QUERY,
      };
    } catch (error) {
      const details = errorDetails(error, 'Oracle query failed');
      throw new ServiceUnavailableException({ code: 'DATABASE_UNAVAILABLE', ...details });
    } finally {
      if (connection) {
        await connection.close().catch(() => {
          console.error('Oracle connection release failed.');
        });
      }
    }
  }
}
