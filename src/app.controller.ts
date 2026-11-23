import { Controller, Get, Header } from '@nestjs/common';
import { DeepSecPublic } from 'nestjs-oracledb-deepsec';
import { DatabaseService, DEMO_QUERY } from './database.service';

@Controller('api')
export class AppController {
  constructor(private readonly database: DatabaseService) {}

  @DeepSecPublic()
  @Get('health')
  health() {
    return { application: 'ok', query: DEMO_QUERY };
  }

  @Get('query')
  @Header('Cache-Control', 'no-store')
  query() {
    return this.database.runQuery();
  }
}
