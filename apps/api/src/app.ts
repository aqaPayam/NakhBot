import { randomUUID } from 'node:crypto';

import {
  Body,
  Catch,
  Controller,
  Get,
  Inject,
  Module,
  Post,
  type DynamicModule,
  type ExceptionFilter,
  type ArgumentsHost,
  type OnApplicationShutdown,
  type PipeTransform,
} from '@nestjs/common';
import { Ajv2020 as Ajv, type ValidateFunction } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { Logger } from 'pino';

import { CreateSampleEffectHandler } from '@nakh/application';
import {
  CreateSampleEffectCommandSchema,
  type CreateSampleEffectCommand,
  type CreateSampleEffectResult,
  type ProblemDetails,
} from '@nakh/contracts';
import { ApplicationError, SystemClock } from '@nakh/domain';
import type { AppConfig } from '@nakh/config';
import {
  createDatabase,
  PostgresFoundationStore,
  SystemIdGenerator,
  type NakhDatabase,
} from '@nakh/persistence-postgres';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const DATABASE = Symbol('DATABASE');
export const LOGGER = Symbol('LOGGER');
export const SAMPLE_HANDLER = Symbol('SAMPLE_HANDLER');

const addFormats = formatsModule.default as unknown as (
  ajv: InstanceType<typeof Ajv>,
) => InstanceType<typeof Ajv>;

class TypeBoxPipe implements PipeTransform<unknown, CreateSampleEffectCommand> {
  private readonly validate: ValidateFunction;

  public constructor(schema: object) {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    this.validate = ajv.compile(schema);
  }

  public transform(value: unknown): CreateSampleEffectCommand {
    if (!this.validate(value)) {
      const details = Object.fromEntries(
        (this.validate.errors ?? []).map((error, index) => [
          `field_${index}`,
          `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
        ]),
      );
      throw new ApplicationError('invalid_request', 'The request body is invalid.', 400, details);
    }
    return value as CreateSampleEffectCommand;
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  public constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  public catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<FastifyReply>();
    const request = context.getRequest<FastifyRequest>();
    const requestHeader = request.headers['x-request-id'];
    const requestId = typeof requestHeader === 'string' ? requestHeader : randomUUID();
    const error =
      exception instanceof ApplicationError
        ? exception
        : new ApplicationError('internal_error', 'An internal error occurred.', 500);
    if (error.status >= 500) {
      this.logger.error(
        { err: exception, requestId, operation: request.routeOptions.url },
        'request failed',
      );
    }
    const problem: ProblemDetails = {
      type: `https://errors.nakh.invalid/${error.code}`,
      title: error.code,
      status: error.status,
      code: error.code,
      requestId,
      ...(error.status < 500 ? { detail: error.message } : {}),
      ...(error.details === undefined
        ? {}
        : {
            errors: Object.entries(error.details).map(([path, code]) => ({ path, code })),
          }),
    };
    void response.status(error.status).send(problem);
  }
}

@Controller('health')
class HealthController {
  public constructor(@Inject(DATABASE) private readonly database: NakhDatabase) {}

  @Get('live')
  public live(): Readonly<{ status: 'ok' }> {
    return { status: 'ok' };
  }

  @Get('ready')
  public async ready(): Promise<Readonly<{ status: 'ok' }>> {
    await sql`select 1`.execute(this.database);
    return { status: 'ok' };
  }
}

@Controller('v1/internal/foundation')
class FoundationController {
  public constructor(
    @Inject(SAMPLE_HANDLER) private readonly handler: CreateSampleEffectHandler,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('sample-effects')
  public async create(
    @Body(new TypeBoxPipe(CreateSampleEffectCommandSchema)) command: CreateSampleEffectCommand,
  ): Promise<CreateSampleEffectResult> {
    if (this.config.environment === 'production') {
      throw new ApplicationError('not_found', 'The resource was not found.', 404);
    }
    return this.handler.execute(command);
  }
}

class DatabaseLifecycle implements OnApplicationShutdown {
  public constructor(@Inject(DATABASE) private readonly database: NakhDatabase) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.database.destroy();
  }
}

@Module({})
export class ApiModule {
  public static register(config: AppConfig, logger: Logger): DynamicModule {
    const database = createDatabase(config.database);
    return {
      module: ApiModule,
      controllers: [HealthController, FoundationController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        { provide: DATABASE, useValue: database },
        {
          provide: SAMPLE_HANDLER,
          useValue: new CreateSampleEffectHandler(
            new PostgresFoundationStore(database),
            new SystemIdGenerator(),
            new SystemClock(),
          ),
        },
        DatabaseLifecycle,
        ApiExceptionFilter,
      ],
    };
  }
}
