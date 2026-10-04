import {
  MODERATION_RECONCILIATION_PHASES,
  type ModerationReconciliationPhase,
} from '@nakh/application';
export type Cursor = Readonly<{
  phase: ModerationReconciliationPhase;
  lastId?: string;
  lastPairHighId?: string;
}>;
export type Finding = Readonly<{
  anomalyType: string;
  entityId: string;
  keyId: string;
  entityType:
    | 'report'
    | 'moderation_review'
    | 'moderation_action'
    | 'restriction_episode'
    | 'support_thread'
    | 'user_appeal'
    | 'admin_user'
    | 'admin_action_log'
    | 'internal_block';
  safeDetail: Readonly<Record<string, string>>;
}>;
export type Scan = Readonly<{
  findings: readonly Finding[];
  scannedCount: number;
  nextCursor: Cursor | undefined;
}>;
export function nextPage(
  cursor: Cursor,
  rows: readonly Readonly<{ id: string }>[],
  limit: number,
): Cursor | undefined {
  const lastId = rows.at(-1)?.id;
  if (rows.length === limit && lastId !== undefined) return { phase: cursor.phase, lastId };
  const nextPhase =
    MODERATION_RECONCILIATION_PHASES[MODERATION_RECONCILIATION_PHASES.indexOf(cursor.phase) + 1];
  return nextPhase === undefined ? undefined : { phase: nextPhase };
}
