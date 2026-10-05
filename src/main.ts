import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { directClientsCanSpoof, parseListenHost, parseTrustProxy } from './common/trust-proxy';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Behind a reverse proxy, so the per-IP limits see the visitor and not the proxy (see TRUST_PROXY in .env.example)
  const trust = parseTrustProxy(process.env.TRUST_PROXY);
  if (trust !== undefined) app.set('trust proxy', trust);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const port = process.env.PORT ?? 4100;
  const host = parseListenHost(process.env.HOST);
  if (directClientsCanSpoof(trust, host)) {
    // The proxy's header is believed: anyone who can reach this port directly could fake it
    new Logger('Bootstrap').warn(`TRUST_PROXY is set and the service listens on every address: make sure only the proxy can reach port ${port}, or set HOST=127.0.0.1`);
  }
  await (host ? app.listen(port, host) : app.listen(port));
}

bootstrap();
