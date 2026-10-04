import type { OpaqueTokenStore } from '@nakh/application';
import {
  PostgresConfirmedAppealReveals,
  PostgresConfirmedSupportReveals,
  PostgresPrepareSupportActionHandler,
  PostgresPrepareAppealReviewAccessHandler,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  TelegramAdminSafetyContentAdapter,
  TelegramAdminSafetyReadVault,
  TelegramAdminSafetyReadPreparation,
  TelegramAdminSafetyTargetSelection,
  TelegramAdminReadConfirmationMenus,
  type TelegramAdminTextDelivery,
  type TelegramAdminSessionVerifier,
  type M7TextRenderer,
} from '@nakh/telegram';

/** Explicit composition only. A trusted selected-target UI calls prepare; authenticated private
 * webhook callbacks call handle. Ordinary startup enables neither session nor admin delivery. */
export function createTelegramAdminSafetyReadIngress(
  input: Readonly<{
    database: NakhDatabase;
    tokens: OpaqueTokenStore;
    adminKey: Uint8Array;
    uiEncryptionKey: Uint8Array;
    uiReferenceKey: Uint8Array;
    sessions: TelegramAdminSessionVerifier;
    renderer: M7TextRenderer;
    delivery: TelegramAdminTextDelivery;
  }>,
): Readonly<{
  prepare: TelegramAdminSafetyReadPreparation['prepare'];
  select: TelegramAdminSafetyTargetSelection['select'];
  handle: TelegramAdminSafetyContentAdapter['handle'];
}> {
  const support = new PostgresConfirmedSupportReveals(input.database, input.tokens, input.adminKey);
  const appeals = new PostgresConfirmedAppealReveals(input.database, input.tokens, input.adminKey);
  const vault = new TelegramAdminSafetyReadVault(
    input.tokens,
    input.uiEncryptionKey,
    input.uiReferenceKey,
  );
  const menus = new TelegramAdminReadConfirmationMenus(
    input.sessions,
    vault,
    input.renderer,
    input.delivery,
  );
  const preparation = new TelegramAdminSafetyReadPreparation(
    input.sessions,
    support,
    appeals,
    vault,
    menus,
  );
  const reads = new TelegramAdminSafetyContentAdapter(
    input.sessions,
    vault,
    support,
    appeals,
    input.delivery,
    input.renderer,
  );
  const selections = new TelegramAdminSafetyTargetSelection(
    input.sessions,
    new PostgresPrepareSupportActionHandler(input.database, input.tokens, input.adminKey),
    new PostgresPrepareAppealReviewAccessHandler(input.database, input.tokens, input.adminKey),
    input.tokens,
    input.uiReferenceKey,
    preparation,
  );
  return Object.freeze({
    select: selections.select.bind(selections),
    prepare: preparation.prepare.bind(preparation),
    handle: reads.handle.bind(reads),
  });
}
