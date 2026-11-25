import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { AzureSessionGuard } from '../auth/azure-session.guard';
import { EmployeesService } from './employees.service';

@Controller('api')
@UseGuards(AzureSessionGuard)
export class EmployeesController {
  constructor(private readonly database: EmployeesService) {}

  @Get('query')
  @Header('Cache-Control', 'no-store')
  query() {
    return this.database.runQuery();
  }
}
