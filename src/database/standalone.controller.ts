import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { AzureSessionGuard } from '../auth/azure-session.guard';
import { StandaloneService } from './standalone.service';

@Controller('api')
@UseGuards(AzureSessionGuard)
export class StandaloneController {
  constructor(private readonly database: StandaloneService) {}

  @Get('standalone')
  @Header('Cache-Control', 'no-store')
  query() {
    return this.database.runQuery();
  }
}
