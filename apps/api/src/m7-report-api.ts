import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
  type DynamicModule,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type {
  GetReportReasonsHandler,
  PrepareSingleReportEvidenceHandler,
  SubmitSingleEvidenceReportHandler,
} from '@nakh/application';
import {
  ReportReasonCatalogSchema,
  PreparedReportEvidenceSchema,
  PrepareReportEvidenceQuerySchema,
  SubmitReportCommandSchema,
  ReportSubmissionResultSchema,
  type ReportReasonCatalog,
  type PreparedReportEvidence,
  type PrepareReportEvidenceQuery,
  type SubmitReportCommand,
  type ReportSubmissionResult,
} from '@nakh/contracts';
import { M7ApiBoundary, type M7ApiAuthenticator } from './m7-api-boundary.js';

const BOUNDARY = Symbol('M7_API_BOUNDARY');
const REASONS = Symbol('M7_REPORT_REASONS');
const PREPARE = Symbol('M7_REPORT_PREPARE');
const SUBMIT = Symbol('M7_REPORT_SUBMIT');
export interface M7ReportApiOptions {
  readonly authenticator: M7ApiAuthenticator;
  readonly reasons: Pick<GetReportReasonsHandler, 'execute'>;
  readonly prepare?: Pick<PrepareSingleReportEvidenceHandler, 'execute'>;
  readonly submit?: Pick<SubmitSingleEvidenceReportHandler, 'execute'>;
}

@Controller('v1/reports')
class SubmitReportController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(SUBMIT) private readonly submit: Pick<SubmitSingleEvidenceReportHandler, 'execute'>,
  ) {}
  @Post()
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async report(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ReportSubmissionResult> {
    const actor = await this.boundary.actor(request, 'user');
    const command = this.boundary.parse<SubmitReportCommand>(
      SubmitReportCommandSchema,
      body,
      actor,
    );
    return this.boundary.result(ReportSubmissionResultSchema, () =>
      this.submit.execute(command, actor),
    );
  }
}

@Controller('v1/reports')
class PrepareReportController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(PREPARE) private readonly prepare: Pick<PrepareSingleReportEvidenceHandler, 'execute'>,
  ) {}
  @Post('prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async evidence(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<PreparedReportEvidence> {
    const actor = await this.boundary.actor(request, 'user');
    const query = this.boundary.parse<PrepareReportEvidenceQuery>(
      PrepareReportEvidenceQuerySchema,
      body,
      actor,
    );
    return this.boundary.result(PreparedReportEvidenceSchema, () =>
      this.prepare.execute(query, actor),
    );
  }
}

@Controller('v1/reports')
class ReportController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(REASONS) private readonly reasons: Pick<GetReportReasonsHandler, 'execute'>,
  ) {}
  @Get('reasons')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async catalog(@Req() request: FastifyRequest): Promise<ReportReasonCatalog> {
    const actor = await this.boundary.actor(request, 'user');
    if (actor.kind !== 'user') throw new Error('Invalid authenticated report actor');
    const user = { kind: 'user' as const, userId: actor.userId };
    return this.boundary.result(ReportReasonCatalogSchema, () =>
      this.reasons.execute(
        {
          actor: user,
          requestId: randomUUID(),
        },
        user,
      ),
    );
  }
}

/** Routes are absent unless the host supplies a real verifier and authorized application ports. */
@Module({})
export class M7ReportApiModule {
  public static register(options: M7ReportApiOptions): DynamicModule {
    return {
      module: M7ReportApiModule,
      controllers: [
        ReportController,
        ...(options.prepare === undefined ? [] : [PrepareReportController]),
        ...(options.submit === undefined ? [] : [SubmitReportController]),
      ],
      providers: [
        { provide: BOUNDARY, useValue: new M7ApiBoundary(options.authenticator) },
        { provide: REASONS, useValue: options.reasons },
        ...(options.prepare === undefined ? [] : [{ provide: PREPARE, useValue: options.prepare }]),
        ...(options.submit === undefined ? [] : [{ provide: SUBMIT, useValue: options.submit }]),
      ],
    };
  }
}
