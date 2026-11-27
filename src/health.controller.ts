import { Controller, Get } from '@nestjs/common';
import { DEMO_QUERY } from './employees/employees.service';

// Public health endpoint; it does not connect to the database.
@Controller('api')
export class HealthController {
  @Get('health')
  health() {
    return { application: 'ok', query: DEMO_QUERY };
  }
}
