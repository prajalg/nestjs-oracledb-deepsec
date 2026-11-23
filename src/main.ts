import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useStaticAssets(join(__dirname, '..', 'public'));
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 7002);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  console.log(`Oracle demo: http://${host}:${port}`);
}
bootstrap().catch(() => {
  console.error('Application failed to start. Check port and database configuration.');
  process.exitCode = 1;
});
