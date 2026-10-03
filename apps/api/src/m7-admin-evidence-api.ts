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
  ConfirmedEvidenceReveals,
  RecordAdminIngressRejectionHandler,
} from '@nakh/application';
import {
  AdminEvidenceRevealResultSchema,
  PrepareEvidenceRevealCommandSchema,
  PreparedAdminConfirmationSchema,
  RevealReportEvidenceCommandSchema,
  type PrepareEvidenceRevealCommand,
  type PreparedAdminConfirmation,
  type RevealReportEvidenceCommand,
  type RevealedReportEvidence,
  type AdminEvidenceRevealResult,
} from '@nakh/contracts';
import { M7ApiBoundary, type M7ApiAuthenticator } from './m7-api-boundary.js';
import { AuditedAdminMutationIngress } from './m7-admin-mutation-boundary.js';
import { adminCommandReceipt } from './m7-admin-outcome.js';

const BOUNDARY = Symbol('M7_REVEAL_BOUNDARY'),
  COMMANDS = Symbol('M7_REVEAL_COMMANDS'),
  INGRESS = Symbol('M7_REVEAL_INGRESS');
export interface M7AdminEvidenceApiOptions {
  readonly authenticator: M7ApiAuthenticator;
  readonly commands: Pick<ConfirmedEvidenceReveals, 'prepare' | 'execute'>;
  readonly journal: Pick<RecordAdminIngressRejectionHandler, 'record' | 'recover'>;
}
@Controller('v1/admin/reports/evidence/reveal')
class EvidenceRevealController {
  public constructor(
    @Inject(BOUNDARY) private readonly boundary: M7ApiBoundary,
    @Inject(COMMANDS) private readonly commands: M7AdminEvidenceApiOptions['commands'],
    @Inject(INGRESS) private readonly ingress: AuditedAdminMutationIngress,
  ) {}
  @Post('prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async prepare(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<PreparedAdminConfirmation> {
    const actor = await this.boundary.actor(request, 'admin');
    const command = this.boundary.parse<PrepareEvidenceRevealCommand>(
      PrepareEvidenceRevealCommandSchema,
      body,
      actor,
    );
    return this.boundary.result(PreparedAdminConfirmationSchema, async () => ({
      confirmationToken: await this.commands.prepare(command, actor),
    }));
  }
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async reveal(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AdminEvidenceRevealResult> {
    return this.boundary.result(AdminEvidenceRevealResultSchema, async () => {
      const result = await this.ingress.execute<
        RevealReportEvidenceCommand,
        RevealedReportEvidence
      >(
        RevealReportEvidenceCommandSchema,
        request,
        body,
        { commandCode: 'moderation.reveal-evidence', requiredPermission: 'view_reports' },
        (command, actor) => this.commands.execute(command, actor),
      );
      const receipt = adminCommandReceipt(result);
      if (result.result === 'succeeded' && !result.replayed) {
        if (result.value === undefined) throw new Error('Missing audited reveal value');
        return {
          ...receipt,
          result: 'succeeded' as const,
          replayed: false as const,
          evidence: result.value,
        };
      }
      if (result.result === 'succeeded')
        return { ...receipt, result: 'succeeded' as const, replayed: true as const };
      return { ...receipt, result: result.result };
    });
  }
}
/** Both the owned reveal transaction and required failure journal must be explicitly supplied. */
@Module({})
export class M7AdminEvidenceApiModule {
  public static register(options: M7AdminEvidenceApiOptions): DynamicModule {
    const boundary = new M7ApiBoundary(options.authenticator);
    return {
      module: M7AdminEvidenceApiModule,
      controllers: [EvidenceRevealController],
      providers: [
        { provide: BOUNDARY, useValue: boundary },
        { provide: COMMANDS, useValue: options.commands },
        { provide: INGRESS, useValue: new AuditedAdminMutationIngress(boundary, options.journal) },
      ],
    };
  }
}
