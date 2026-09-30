import {
  ConfirmedEvidenceReveals,
  type OpaqueTokenStore,
  type ProfileReportSnapshotReader,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';
import { postgresConfirmationBoundary } from './confirmed-support-store.js';
import {
  PostgresProfileEvidenceRevealStore,
  PostgresReportEvidenceRevealStore,
  type ReportEvidenceReaders,
} from './profile-evidence-reveal-store.js';
export class PostgresConfirmedReportEvidenceReveals extends ConfirmedEvidenceReveals {
  public constructor(
    database: NakhDatabase,
    tokens: OpaqueTokenStore,
    key: Uint8Array,
    readers: ReportEvidenceReaders,
    now: () => number = Date.now,
  ) {
    super(
      postgresConfirmationBoundary(database, tokens, key, now),
      new PostgresReportEvidenceRevealStore(database, readers),
    );
  }
}
export class PostgresConfirmedEvidenceReveals extends ConfirmedEvidenceReveals {
  public constructor(
    database: NakhDatabase,
    tokens: OpaqueTokenStore,
    key: Uint8Array,
    snapshots: ProfileReportSnapshotReader,
    now: () => number = Date.now,
  ) {
    super(
      postgresConfirmationBoundary(database, tokens, key, now),
      new PostgresProfileEvidenceRevealStore(database, snapshots),
    );
  }
}
