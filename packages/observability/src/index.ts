import { metrics, trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import pino, { type DestinationStream, type Logger } from 'pino';

export * from './m1-metrics.js';
export * from './m2-metrics.js';
export * from './m3-metrics.js';
export * from './m4-metrics.js';

export type TelemetryConfig = Readonly<{
  enabled: boolean;
  endpoint: string;
  serviceName: string;
  release: string;
  environment: string;
}>;

export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.x-telegram-bot-api-secret-token',
  'req.body',
  'request.body',
  'command.data',
  'telegramBotToken',
  'webhookSecret',
  'telegramUserId',
  'username',
  'userId',
  'name',
  'bio',
  'highlight',
  'draftData',
  'requestedValue',
  'reason',
  'invoicePayload',
  'chargeId',
  'storageKey',
  'signedUrl',
  '*.telegramBotToken',
  '*.webhookSecret',
  '*.telegramUserId',
  '*.username',
  '*.userId',
  '*.name',
  '*.bio',
  '*.highlight',
  '*.draftData',
  '*.requestedValue',
  '*.reason',
  '*.invoicePayload',
  '*.chargeId',
  '*.storageKey',
  '*.signedUrl',
];

export function createLogger(
  bindings: Readonly<Record<string, string>>,
  destination?: DestinationStream,
): Logger {
  const options = {
    level: process.env.NAKH_LOG_LEVEL ?? 'info',
    base: bindings,
    redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      err: pino.stdSerializers.err,
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

export function startTelemetry(config: TelemetryConfig): Promise<NodeSDK | undefined> {
  if (!config.enabled) return Promise.resolve(undefined);

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.release,
    'deployment.environment.name': config.environment,
  });
  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${config.endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${config.endpoint}/v1/metrics` }),
      exportIntervalMillis: 30_000,
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  return Promise.resolve(sdk);
}

export async function inSpan<T>(name: string, operation: () => Promise<T>): Promise<T> {
  return trace.getTracer('nakh').startActiveSpan(name, async (span: Span) => {
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error('Unknown error'));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

export const foundationMeter = metrics.getMeter('nakh-foundation');
