import type { OpaqueTokenStore } from '@nakh/application';
import {
  PostgresConfirmedAppealReveals,
  PostgresConfirmedSupportReveals,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  TelegramAdminSafetyContentAdapter,
  TelegramAdminSafetyReadVault,
  TelegramAdminSafetyReadPreparation,
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
  return Object.freeze({
    prepare: preparation.prepare.bind(preparation),
    handle: reads.handle.bind(reads),
  });
}
