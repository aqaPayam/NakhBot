import type { FeatureUnlockResult, SpendCreditsForActionCommand } from '@nakh/contracts';
import { ApplicationError, type IdGenerator } from '@nakh/domain';

import type { PaidActionReferenceResolver } from '../billing/funding.js';

export type PaidActionTarget =
  Readonly<{ type: 'like'; targetId: string }> | Readonly<{ type: 'match'; targetId: string }>;

export type SpendCreditsForPaidActionWrite = Readonly<{
  featureUnlockId: string;
  creditTransactionId: string;
  outboxEventId: string;
  userId: string;
  target: PaidActionTarget;
  idempotencyKey: string;
  correlationId: string;
}>;

export type StoredFeatureUnlock = Readonly<{
  id: string;
  featureType: 'liked_by_profile_unlock' | 'chat_unlock';
  unlockedAt: Date;
  replayed: boolean;
}>;

export interface PaidActionStore {
  spendCredits(write: SpendCreditsForPaidActionWrite): Promise<StoredFeatureUnlock>;
}

export class SpendCreditsForPaidActionHandler {
  public constructor(
    private readonly store: PaidActionStore,
    private readonly references: PaidActionReferenceResolver,
    private readonly ids: IdGenerator,
  ) {}

  public async execute(command: SpendCreditsForActionCommand): Promise<FeatureUnlockResult> {
    if (command.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const target = await this.resolveTarget(command);
    const unlock = await this.store.spendCredits({
      featureUnlockId: this.ids.uuid(),
      creditTransactionId: this.ids.uuid(),
      outboxEventId: this.ids.uuid(),
      userId: command.actor.userId,
      target,
      idempotencyKey: command.idempotencyKey,
      correlationId: command.requestId,
    });
    return {
      featureUnlockId: unlock.id,
      featureType: unlock.featureType,
      status: 'active',
      unlockedAt: unlock.unlockedAt.toISOString(),
      replayed: unlock.replayed,
    };
  }

  private async resolveTarget(command: SpendCreditsForActionCommand): Promise<PaidActionTarget> {
    const target = command.data.target;
    const targetId =
      target.type === 'liked_by_profile_unlock'
        ? await this.references.resolveLikedByAction(target.actionToken, command.actor.userId)
        : await this.references.resolveChatUnlockAction(target.actionToken, command.actor.userId);
    if (targetId === undefined)
      throw new ApplicationError('unlock_unavailable', 'error.billing.unlock_unavailable', 409);
    return { type: target.type === 'liked_by_profile_unlock' ? 'like' : 'match', targetId };
  }
}
