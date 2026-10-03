import type { OpaqueTokenStore, ReportTokens } from '@nakh/application';
import {
  createPostgresReportServices,
  PostgresGetReportReasonsHandler,
  type NakhDatabase,
  type ReportEvidenceCapabilities,
} from '@nakh/persistence-postgres';
import type { M7ApiAuthenticator } from './m7-api-boundary.js';
import type { M7ReportApiOptions } from './m7-report-api.js';

/** Trusted host composition; keys and identity verification are configured before serving requests. */
export function createM7ReportApiOptions(
  input: Readonly<{
    database: NakhDatabase;
    authenticator: M7ApiAuthenticator;
    reportTokens: ReportTokens;
    adminTokens: OpaqueTokenStore;
    adminKey: Uint8Array;
    capabilities: ReportEvidenceCapabilities;
  }>,
): M7ReportApiOptions {
  const services = createPostgresReportServices(
    input.database,
    input.reportTokens,
    input.adminTokens,
    input.adminKey,
    input.capabilities,
  );
  return Object.freeze({
    authenticator: input.authenticator,
    reasons: new PostgresGetReportReasonsHandler(input.database),
    prepare: services.prepare,
    submit: services.submit,
  });
}
