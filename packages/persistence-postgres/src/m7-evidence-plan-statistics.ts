import { sql } from 'kysely';
import type { NakhDatabase } from './database.js';

/** Bulk synthetic evidence is still uncommitted, so autovacuum cannot refresh its statistics.
 * Refresh before the real integrity-source verification, retaining every predicate and count. */
export async function analyzeM7EvidencePlanTables(database: NakhDatabase): Promise<void> {
  await sql`ANALYZE moderation.reports,moderation.report_evidence,moderation.report_snapshots,
    media.report_photo_evidence_holds,media.photo_variants,media.media_assets,
    chat.chat_message_snapshots`.execute(database);
}
