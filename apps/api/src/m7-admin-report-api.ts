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
import type { GetReportMetadataPageHandler } from '@nakh/application';
import {
  GetReportMetadataPageQuerySchema,
  ReportMetadataPageSchema,
  type GetReportMetadataPageQuery,
  type ReportMetadataPage,
} from '@nakh/contracts';
import { M7ApiBoundary, type M7ApiAuthenticator } from './m7-api-boundary.js';

const BOUNDARY = Symbol('M7_ADMIN_API_BOUNDARY'),
  METADATA = Symbol('M7_ADMIN_REPORT_METADATA');
export interface M7AdminReportApiOptions {
  readonly authenticator: M7ApiAuthenticator;
  readonly metadata: Pick<GetReportMetadataPageHandler, 'execute'>;
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
      controllers: [ReportMetadataController],
      providers: [
        { provide: BOUNDARY, useValue: new M7ApiBoundary(options.authenticator) },
        { provide: METADATA, useValue: options.metadata },
      ],
    };
  }
}
