import type {
  ChangeLocaleCommand,
  ChangeSettingsResult,
  ChangeVisibilityCommand,
  RegisterTelegramIdentityCommand,
  RegisterTelegramIdentityResult,
} from '@nakh/contracts';
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
  command: RegisterTelegramIdentityCommand;
  userId: string;
  accountHistoryId: string;
  auditId: string;
  registrationEventId: string;
  startRouteEventId: string;
  processedAt: Date;
  guestPreviewLimit: number;
  defaultLocale: string;
}>;

export type ChangeSettingsWrite = Readonly<{
  command: ChangeLocaleCommand | ChangeVisibilityCommand;
  auditId: string;
  eventId: string;
  processedAt: Date;
}>;

export interface IdentityStore {
  registerTelegramIdentity(
    write: RegisterTelegramIdentityWrite,
  ): Promise<RegisterTelegramIdentityResult>;
  getByTelegramUserId(telegramUserId: string): Promise<IdentityContextSnapshot | undefined>;
  getByUserId(userId: string): Promise<IdentityContextSnapshot | undefined>;
  changeSettings(write: ChangeSettingsWrite): Promise<ChangeSettingsResult>;
}

export type LocalizationCatalog = Readonly<{
  requestedLocale: string;
  resolvedLocale: string;
  messages: Readonly<Record<string, string>>;
}>;

export interface LocalizationStore {
  loadActiveCatalog(locale: string): Promise<LocalizationCatalog>;
}
