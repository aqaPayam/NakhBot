import type { AdminCommandExecutionResult } from '@nakh/application';
import type { AdminCommandReceipt } from '@nakh/contracts';

/** Public outcomes use a finite vocabulary and never serialize internal effect values. */
export function adminCommandReceipt(
  result: AdminCommandExecutionResult<unknown>,
): AdminCommandReceipt {
  const safeCode =
    result.result === 'succeeded'
      ? 'completed'
      : result.result === 'failed'
        ? 'internal_error'
        : result.safeCode === 'forbidden'
          ? 'forbidden'
          : result.safeCode === 'version_conflict'
            ? 'version_conflict'
            : ['invalid_request', 'admin_reason_invalid'].includes(result.safeCode)
              ? 'invalid_request'
              : 'unavailable';
  return {
    auditId: result.logId,
    result: result.result,
    safeCode,
    recordedAt: result.recordedAt.toISOString(),
    replayed: result.replayed,
  };
}
