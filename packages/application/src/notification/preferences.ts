import type { ChangeNotificationPreferenceCommand } from '@nakh/contracts';
import { ApplicationError, type Clock, type IdGenerator } from '@nakh/domain';

export type NotificationPreferences = Readonly<{
  version: number;
  chatEnabled: boolean;
  likeEnabled: boolean;
  nakhEnabled: boolean;
  matchEnabled: boolean;
}>;
export type NotificationPreferenceWrite = Readonly<{
  command: ChangeNotificationPreferenceCommand;
  auditId: string;
  processedAt: Date;
}>;
export type NotificationPreferenceResult = NotificationPreferences &
  Readonly<{ changed: boolean; replayed: boolean }>;
export interface NotificationPreferenceStore {
  read(): Promise<NotificationPreferences>;
  change(write: NotificationPreferenceWrite): Promise<NotificationPreferenceResult>;
}
export class ChangeNotificationPreferenceHandler {
  public constructor(
    private readonly store: NotificationPreferenceStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}
  public execute(
    input: ChangeNotificationPreferenceCommand,
  ): Promise<NotificationPreferenceResult> {
    const command = structuredClone(input);
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    return this.store.change({ command, auditId: this.ids.uuid(), processedAt: this.clock.now() });
  }
}
