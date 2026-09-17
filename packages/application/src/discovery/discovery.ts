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
