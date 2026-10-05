import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { parseTrustProxy } from './common/trust-proxy';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Behind a reverse proxy, so the per-IP limits see the visitor and not the proxy (see TRUST_PROXY in .env.example)
  const trust = parseTrustProxy(process.env.TRUST_PROXY);
  if (trust !== undefined) app.set('trust proxy', trust);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(process.env.PORT ?? 4100);
}

bootstrap();
