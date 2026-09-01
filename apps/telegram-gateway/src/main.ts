import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { loadConfig } from '@nakh/config';
import { createLogger, startTelemetry } from '@nakh/observability';

import { TelegramGatewayModule } from './app.js';

const config = loadConfig({
  ...process.env,
  NAKH_SERVICE_NAME: process.env.NAKH_SERVICE_NAME ?? 'telegram-gateway',
  NAKH_HTTP_PORT: process.env.NAKH_HTTP_PORT ?? '3001',
});
const logger = createLogger({
  service: config.serviceName,
  release: config.release,
  environment: config.environment,
});
const telemetry = await startTelemetry({
  enabled: config.telemetry.enabled,
  endpoint: config.telemetry.exporterEndpoint,
  serviceName: config.serviceName,
  release: config.release,
  environment: config.environment,
});
const application = await NestFactory.create<NestFastifyApplication>(
  TelegramGatewayModule.register(config),
  new FastifyAdapter({ bodyLimit: 1_048_576, trustProxy: false }),
  { logger: false },
);
application.enableShutdownHooks();
await application.listen({ host: config.http.host, port: config.http.port });
logger.info({ operation: 'service.started', port: config.http.port }, 'service started');

const shutdownTelemetry = async (): Promise<void> => telemetry?.shutdown();
process.once('SIGTERM', () => void shutdownTelemetry());
process.once('SIGINT', () => void shutdownTelemetry());
