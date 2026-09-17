import type { GetNextExploreCandidateQuery, SaveExploreFilterCommand } from '@nakh/contracts';
import { ApplicationError, type Clock, type IdGenerator } from '@nakh/domain';

export type ExploreFilterResult = Readonly<{
  version: number;
  targetGenderOptionIds: readonly string[];
  minAge: number;
  maxAge: number;
  cityId: string;
  relationshipGoalCode?: string;
  replayed: boolean;
}>;

export type CandidateReservation = Readonly<{
  deliveryId: string;
  targetUserId: string;
  mode: GetNextExploreCandidateQuery['mode'];
  filterVersion: number;
  expiresAt: string;
}>;

export interface ExploreFilterStore {
  saveFilter(
    command: SaveExploreFilterCommand,
    generated: Readonly<{ auditId: string; eventId: string; processedAt: Date }>,
  ): Promise<ExploreFilterResult>;
}

export interface CandidateReservationStore {
  reserveNext(
    query: GetNextExploreCandidateQuery,
    generated: Readonly<{ deliveryId: string; eventId: string; reservedAt: Date }>,
  ): Promise<CandidateReservation | undefined>;
}

export type CandidateDeliveryResult = Readonly<{
  deliveryId: string;
  mode: GetNextExploreCandidateQuery['mode'];
  state: 'delivered' | 'failed';
  replayed: boolean;
}>;

export interface CandidateDeliveryStore {
  recordDelivered(
    input: Readonly<{ deliveryId: string; providerMessageId: string }>,
    generated: Readonly<{
      auditId: string;
      deliveryEventId: string;
      consumptionEventId: string;
      processedAt: Date;
    }>,
  ): Promise<CandidateDeliveryResult>;
  recordDefinitiveFailure(
    input: Readonly<{ deliveryId: string; reasonCode: string }>,
    generated: Readonly<{ auditId: string; eventId: string; processedAt: Date }>,
  ): Promise<CandidateDeliveryResult>;
}

function assertUser(actor: Readonly<{ kind: string; userId: string }>): void {
  if (actor.kind !== 'user')
    throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
}

export class SaveExploreFilterHandler {
  public constructor(
    private readonly store: ExploreFilterStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public execute(command: SaveExploreFilterCommand): Promise<ExploreFilterResult> {
    assertUser(command.actor);
    return this.store.saveFilter(command, {
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      processedAt: this.clock.now(),
    });
  }
}

export class GetNextExploreCandidateHandler {
  public constructor(
    private readonly store: CandidateReservationStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public execute(query: GetNextExploreCandidateQuery): Promise<CandidateReservation | undefined> {
    assertUser(query.actor);
    return this.store.reserveNext(query, {
      deliveryId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      reservedAt: this.clock.now(),
    });
  }
}

export class RecordCandidateDeliveryHandler {
  public constructor(
    private readonly store: CandidateDeliveryStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public recordDelivered(
    input: Readonly<{ deliveryId: string; providerMessageId: string }>,
  ): Promise<CandidateDeliveryResult> {
    if (!/^[1-9][0-9]{0,18}$/u.test(input.providerMessageId))
      throw new ApplicationError(
        'invalid_request',
        'error.discovery.provider_message_invalid',
        400,
      );
    return this.store.recordDelivered(input, {
      auditId: this.ids.uuid(),
      deliveryEventId: this.ids.uuid(),
      consumptionEventId: this.ids.uuid(),
      processedAt: this.clock.now(),
    });
  }

  public recordDefinitiveFailure(
    input: Readonly<{ deliveryId: string; reasonCode: string }>,
  ): Promise<CandidateDeliveryResult> {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(input.reasonCode))
      throw new ApplicationError('invalid_request', 'error.discovery.failure_reason_invalid', 400);
    return this.store.recordDefinitiveFailure(input, {
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      processedAt: this.clock.now(),
    });
  }
}
