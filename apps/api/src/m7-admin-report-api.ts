import {
  Body,
  Controller,
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
  PrepareReportEvidenceAccessHandler,
  GetAdminReportQueueActionsHandler,
  GetReportMetadataPageHandler,
  GetReportEvidenceActionsHandler,
} from '@nakh/application';
import {
  PrepareReportEvidenceAccessQuerySchema,
  PreparedReportEvidenceAccessSchema,
  type PrepareReportEvidenceAccessQuery,
  type PreparedReportEvidenceAccess,
  GetAdminReportQueueActionsQuerySchema,
  AdminReportQueueActionsSchema,
  type GetAdminReportQueueActionsQuery,
  type AdminReportQueueActions,
  GetReportMetadataPageQuerySchema,
  ReportMetadataPageSchema,
  GetReportEvidenceMetadataQuerySchema,
  ReportEvidenceActionsSchema,
  type GetReportEvidenceMetadataQuery,
  type ReportEvidenceActions,
  type GetReportMetadataPageQuery,
  type ReportMetadataPage,
} from '@nakh/contracts';
import { M7ApiBoundary, type M7ApiAuthenticator } from './m7-api-boundary.js';
import {
  M7AdminEvidenceApiModule,
  type M7AdminEvidenceApiOptions,
} from './m7-admin-evidence-api.js';

const BOUNDARY = Symbol('M7_ADMIN_API_BOUNDARY'),
  METADATA = Symbol('M7_ADMIN_REPORT_METADATA'),
  ACTIONS = Symbol('M7_ADMIN_EVIDENCE_ACTIONS'),
  QUEUE_ACTIONS = Symbol('M7_ADMIN_QUEUE_ACTIONS'),
  ACCESS = Symbol('M7_REPORT_EVIDENCE_ACCESS');
export interface M7AdminReportApiOptions {
  readonly authenticator: M7ApiAuthenticator;
  readonly metadata: Pick<GetReportMetadataPageHandler, 'execute'>;
  readonly evidenceActions?: Pick<GetReportEvidenceActionsHandler, 'execute'>;
  readonly evidenceReveals?: Omit<M7AdminEvidenceApiOptions, 'authenticator'>;
  readonly queueActions?: Pick<GetAdminReportQueueActionsHandler, 'execute'>;
  readonly evidenceAccess?: Pick<PrepareReportEvidenceAccessHandler, 'execute'>;
}
@Controller('v1/admin/reports/evidence')
class EvidenceActionsController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(ACTIONS) private readonly actions: Pick<GetReportEvidenceActionsHandler, 'execute'>,
  ) {}
  @Post('actions')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async select(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ReportEvidenceActions> {
    const actor = await this.boundary.actor(request, 'admin');
    const query = this.boundary.parse<GetReportEvidenceMetadataQuery>(
      GetReportEvidenceMetadataQuerySchema,
      body,
      actor,
    );
    return this.boundary.result(ReportEvidenceActionsSchema, () =>
      this.actions.execute(query, actor),
    );
  }
}
@Controller('v1/admin/reports')
class ReportMetadataController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(METADATA) private readonly metadata: Pick<GetReportMetadataPageHandler, 'execute'>,
  ) {}
  @Post('metadata')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async page(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ReportMetadataPage> {
    const actor = await this.boundary.actor(request, 'admin');
    const query = this.boundary.parse<GetReportMetadataPageQuery>(
      GetReportMetadataPageQuerySchema,
      body,
      actor,
    );
    return this.boundary.result(ReportMetadataPageSchema, () =>
      this.metadata.execute(query, actor),
    );
  }
}
@Controller('v1/admin/reports/queue')
class ReportQueueActionsController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(QUEUE_ACTIONS)
    private readonly actions: NonNullable<M7AdminReportApiOptions['queueActions']>,
  ) {}
  @Post('actions')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async prepare(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AdminReportQueueActions> {
    const actor = await this.boundary.actor(request, 'admin');
    const query = this.boundary.parse<GetAdminReportQueueActionsQuery>(
      GetAdminReportQueueActionsQuerySchema,
      body,
      actor,
    );
    return this.boundary.result(AdminReportQueueActionsSchema, () =>
      this.actions.execute(query, actor),
    );
  }
}
@Controller('v1/admin/reports/evidence/access')
class ReportEvidenceAccessController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(ACCESS) private readonly access: NonNullable<M7AdminReportApiOptions['evidenceAccess']>,
  ) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async prepare(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<PreparedReportEvidenceAccess> {
    const actor = await this.boundary.actor(request, 'admin');
    const query = this.boundary.parse<PrepareReportEvidenceAccessQuery>(
      PrepareReportEvidenceAccessQuerySchema,
      body,
      actor,
    );
    return this.boundary.result(PreparedReportEvidenceAccessSchema, () =>
      this.access.execute(query, actor),
    );
  }
}
/** Explicit host registration; admin credentials require the separate admin audience and MFA. */
@Module({})
export class M7AdminReportApiModule {
  public static register(options: M7AdminReportApiOptions): DynamicModule {
    return {
      module: M7AdminReportApiModule,
      imports:
        options.evidenceReveals === undefined
          ? []
          : [
              M7AdminEvidenceApiModule.register({
                authenticator: options.authenticator,
                ...options.evidenceReveals,
              }),
            ],
      controllers: [
        ...(options.evidenceAccess === undefined ? [] : [ReportEvidenceAccessController]),
        ...(options.queueActions === undefined ? [] : [ReportQueueActionsController]),
        ReportMetadataController,
        ...(options.evidenceActions === undefined ? [] : [EvidenceActionsController]),
      ],
      providers: [
        ...(options.evidenceAccess === undefined
          ? []
          : [{ provide: ACCESS, useValue: options.evidenceAccess }]),
        ...(options.queueActions === undefined
          ? []
          : [{ provide: QUEUE_ACTIONS, useValue: options.queueActions }]),
        { provide: BOUNDARY, useValue: new M7ApiBoundary(options.authenticator) },
        { provide: METADATA, useValue: options.metadata },
        ...(options.evidenceActions === undefined
          ? []
          : [{ provide: ACTIONS, useValue: options.evidenceActions }]),
      ],
    };
  }
}
