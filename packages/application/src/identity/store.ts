import type { AccountState, EntryRoute, ProfileCompletionStatus } from '@nakh/domain';

export type IdentityContextSnapshot = Readonly<{
  userId: string;
  accountState: AccountState;
  profileCompletion: ProfileCompletionStatus | null;
  visibilityEnabled: boolean;
  uiLocale: string;
  guestPreviewCount: number;
  guestPreviewLimit: number;
  entryRoute: EntryRoute;
  accountVersion: number;
  settingsVersion: number;
}>;

export type RegisterTelegramIdentityWrite = Readonly<{
  userId: string;
  accountHistoryId: string;
  telegramUserId: string;
  username: string | null;
  occurredAt: Date;
  guestPreviewLimit: number;
  defaultLocale: string;
}>;

export type RegisterTelegramIdentityStoreResult = Readonly<{
  context: IdentityContextSnapshot;
  created: boolean;
}>;

export interface IdentityStore {
  registerOrResolveTelegramIdentity(
    write: RegisterTelegramIdentityWrite,
  ): Promise<RegisterTelegramIdentityStoreResult>;
  getByTelegramUserId(telegramUserId: string): Promise<IdentityContextSnapshot | undefined>;
}

export type LocalizationCatalog = Readonly<{
  requestedLocale: string;
  resolvedLocale: string;
  messages: Readonly<Record<string, string>>;
}>;

export interface LocalizationStore {
  loadActiveCatalog(locale: string): Promise<LocalizationCatalog>;
}
