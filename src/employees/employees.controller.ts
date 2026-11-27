import { DeepSecInterceptor } from '../deepsec/deepsec.interceptor';
import { Controller, Get, Header, UseGuards, UseInterceptors } from '@nestjs/common';
import { AzureSessionGuard } from '../auth/azure-session.guard';
import { EmployeesService } from './employees.service';

@Controller('api')
@UseGuards(AzureSessionGuard)
// Apply DeepSec identity mapping to all handlers in this controller.
@UseInterceptors(DeepSecInterceptor)
export class EmployeesController {
  constructor(private readonly database: EmployeesService) {}

  @Get('query')
  @Header('Cache-Control', 'no-store')
  query() {
    return this.database.runQuery();
  }
}
