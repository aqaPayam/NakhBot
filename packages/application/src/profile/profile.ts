import type {
  ConfirmSignupCommand,
  ConfirmSignupResult,
  OwnProfile,
  UpdateProfileCommand,
} from '@nakh/contracts';
import { ApplicationError, type Actor, type Clock, type IdGenerator } from '@nakh/domain';

export type ConfirmationMediaSelection = Readonly<{
  primaryMediaAssetId: string;
  additionalMediaAssetIds: readonly string[];
}>;

export type ProfileMediaEligibilityProof = Readonly<{
  proofId: string;
  userId: string;
  primaryMediaAssetId: string;
  acceptedMediaAssetIds: readonly string[];
  issuedAt: Date;
  expiresAt: Date;
}>;

export interface ProfileMediaEligibilityPort {
  issueProof(
    userId: string,
    selection: ConfirmationMediaSelection,
  ): Promise<ProfileMediaEligibilityProof>;
}

export type ConfirmSignupWrite = Readonly<{
  command: ConfirmSignupCommand;
  proof: ProfileMediaEligibilityProof;
  profileId: string;
  accountHistoryId: string;
  auditId: string;
  profileEventId: string;
  accountEventId: string;
  processedAt: Date;
}>;

export type UpdateProfileWrite = Readonly<{
  command: UpdateProfileCommand;
  auditId: string;
  eventId: string;
  processedAt: Date;
}>;

export interface ProfileStore {
  getConfirmationMedia(userId: string): Promise<ConfirmationMediaSelection>;
  confirmSignup(write: ConfirmSignupWrite): Promise<ConfirmSignupResult>;
  updateOwnProfile(write: UpdateProfileWrite): Promise<OwnProfile>;
  getOwnProfile(userId: string): Promise<OwnProfile | undefined>;
}

function requireUser(actor: Actor): string {
  if (actor.kind !== 'user')
    throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
  return actor.userId;
}

export class ConfirmSignupHandler {
  public constructor(
    private readonly store: ProfileStore,
    private readonly media: ProfileMediaEligibilityPort,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(command: ConfirmSignupCommand): Promise<ConfirmSignupResult> {
    const userId = requireUser(command.actor);
    const selection = await this.store.getConfirmationMedia(userId);
    const proof = await this.media.issueProof(userId, selection);
    return this.store.confirmSignup({
      command,
      proof,
      profileId: this.ids.uuid(),
      accountHistoryId: this.ids.uuid(),
      auditId: this.ids.uuid(),
      profileEventId: this.ids.uuid(),
      accountEventId: this.ids.uuid(),
      processedAt: this.clock.now(),
    });
  }
}

export class UpdateOwnProfileHandler {
  public constructor(
    private readonly store: ProfileStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(command: UpdateProfileCommand): Promise<OwnProfile> {
    requireUser(command.actor);
    return this.store.updateOwnProfile({
      command,
      auditId: this.ids.uuid(),
      eventId: this.ids.uuid(),
      processedAt: this.clock.now(),
    });
  }
}

export class GetOwnProfileHandler {
  public constructor(private readonly store: ProfileStore) {}

  public async execute(actor: Actor): Promise<OwnProfile | undefined> {
    return this.store.getOwnProfile(requireUser(actor));
  }
}
