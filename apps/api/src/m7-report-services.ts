import type { OpaqueTokenStore, ReportTokens } from '@nakh/application';
import {
  createPostgresReportServices,
  PostgresGetReportReasonsHandler,
  PostgresGetReportMetadataPageHandler,
  PostgresRecordAdminIngressRejectionHandler,
  PostgresGetAdminReportQueueActionsHandler,
  PostgresPrepareReportEvidenceAccessHandler,
  type NakhDatabase,
  type ReportEvidenceCapabilities,
} from '@nakh/persistence-postgres';
import type { M7ApiAuthenticator } from './m7-api-boundary.js';
import type { M7ReportApiOptions } from './m7-report-api.js';
import type { M7AdminReportApiOptions } from './m7-admin-report-api.js';

export type M7ReportHostConfiguration = Readonly<{
  database: NakhDatabase;
  authenticator: M7ApiAuthenticator;
  reportTokens: ReportTokens;
  adminTokens: OpaqueTokenStore;
  adminKey: Uint8Array;
  capabilities: ReportEvidenceCapabilities;
}>;

/** Trusted host composition; keys and identity verification are configured before serving requests. */
export function createM7ReportHostOptions(input: M7ReportHostConfiguration): Readonly<{
  reports: M7ReportApiOptions;
  adminReports: M7AdminReportApiOptions;
}> {
  const services = createPostgresReportServices(
    input.database,
    input.reportTokens,
    input.adminTokens,
    input.adminKey,
    input.capabilities,
  );
  const reports: M7ReportApiOptions = Object.freeze({
    authenticator: input.authenticator,
    reasons: new PostgresGetReportReasonsHandler(input.database),
    prepare: services.prepare,
    submit: services.submit,
  });
  const adminReports: M7AdminReportApiOptions = Object.freeze({
    evidenceAccess: new PostgresPrepareReportEvidenceAccessHandler(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    queueActions: new PostgresGetAdminReportQueueActionsHandler(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    authenticator: input.authenticator,
    metadata: new PostgresGetReportMetadataPageHandler(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    evidenceActions: services.evidenceActions,
    evidenceReveals: Object.freeze({
      commands: services.reveals,
      journal: new PostgresRecordAdminIngressRejectionHandler(input.database),
    }),
  });
  return Object.freeze({ reports, adminReports });
}
/** Compatibility composition for hosts that only expose the user reporting surface. */
export function createM7ReportApiOptions(input: M7ReportHostConfiguration): M7ReportApiOptions {
  return createM7ReportHostOptions(input).reports;
}
