import { DeepSec } from 'nestjs-oracledb-deepsec';
import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { AzureSessionGuard } from '../auth/azure-session.guard';
import { StandaloneService } from './standalone.service';

@Controller('api')
@UseGuards(AzureSessionGuard)
export class StandaloneController {
  constructor(private readonly database: StandaloneService) {}

  // Custom roles: @DeepSec({ dataRoles: ['SALARY_REPORT'] }) replaces mapped roles for this handler.
  // Requires endUserSecParams on the connection; Oracle must authorize these roles.
  @DeepSec() // Explicit enable; the employees handler uses the global default.
  @Get('standalone')
  @Header('Cache-Control', 'no-store')
  query() {
    return this.database.runQuery();
  }
}
