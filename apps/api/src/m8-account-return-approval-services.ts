import type { OpaqueTokenStore } from '@nakh/application';
import {
  PostgresConfirmedAccountReturnApprovals,
  PostgresSelectAccountReturnApprovalHandler,
  PostgresRecordAdminIngressRejectionHandler,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import type { M7ApiAuthenticator } from './m7-api-boundary.js';
import type { M8AccountReturnApprovalApiOptions } from './m8-account-return-approval-api.js';

export function createM8AccountReturnApprovalOptions(
  input: Readonly<{
    database: NakhDatabase;
    authenticator: M7ApiAuthenticator;
    adminTokens: OpaqueTokenStore;
    adminKey: Uint8Array;
  }>,
): M8AccountReturnApprovalApiOptions {
  return Object.freeze({
    authenticator: input.authenticator,
    selection: new PostgresSelectAccountReturnApprovalHandler(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    commands: new PostgresConfirmedAccountReturnApprovals(
      input.database,
      input.adminTokens,
      input.adminKey,
    ),
    rejections: new PostgresRecordAdminIngressRejectionHandler(input.database),
  });
}
