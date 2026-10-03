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
  GetReportMetadataPageHandler,
  GetReportEvidenceActionsHandler,
} from '@nakh/application';
import {
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

const BOUNDARY = Symbol('M7_ADMIN_API_BOUNDARY'),
  METADATA = Symbol('M7_ADMIN_REPORT_METADATA'),
  ACTIONS = Symbol('M7_ADMIN_EVIDENCE_ACTIONS');
export interface M7AdminReportApiOptions {
  readonly authenticator: M7ApiAuthenticator;
  readonly metadata: Pick<GetReportMetadataPageHandler, 'execute'>;
  readonly evidenceActions?: Pick<GetReportEvidenceActionsHandler, 'execute'>;
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
/** Explicit host registration; admin credentials require the separate admin audience and MFA. */
@Module({})
export class M7AdminReportApiModule {
  public static register(options: M7AdminReportApiOptions): DynamicModule {
    return {
      module: M7AdminReportApiModule,
      controllers: [
        ReportMetadataController,
        ...(options.evidenceActions === undefined ? [] : [EvidenceActionsController]),
      ],
      providers: [
        { provide: BOUNDARY, useValue: new M7ApiBoundary(options.authenticator) },
        { provide: METADATA, useValue: options.metadata },
        ...(options.evidenceActions === undefined
          ? []
          : [{ provide: ACTIONS, useValue: options.evidenceActions }]),
      ],
    };
  }
}
