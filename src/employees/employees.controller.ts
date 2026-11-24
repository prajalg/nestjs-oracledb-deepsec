import { Controller, Get, Header } from '@nestjs/common';
import { DeepSecPublic } from 'nestjs-oracledb-deepsec';
import { EmployeesService, DEMO_QUERY } from './employees.service';

@Controller('api')
export class EmployeesController {
  constructor(private readonly database: EmployeesService) {}

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
