import type { MediaDeliveryGrant, ResolveMediaDeliveryGrantQuery } from '@nakh/contracts';
import { ApplicationError, type Clock } from '@nakh/domain';

type DeliveryPurpose = ResolveMediaDeliveryGrantQuery['purpose'];
type DeliveryVariant = MediaDeliveryGrant['variantType'];

export type AuthorizedMediaDelivery = Readonly<{
  authorityId: string;
  issuedAt: number;
  expiresAt: number;
  deliveryPath: string;
  variantType: DeliveryVariant;
  cachePolicy: MediaDeliveryGrant['cachePolicy'];
}>;

export interface MediaDeliveryAuthorizationPort {
  authorize(
    input: Readonly<{
      actor: ResolveMediaDeliveryGrantQuery['actor'];
      photoId: string;
      purpose: DeliveryPurpose;
      requestedVariant: DeliveryVariant;
      ttlSeconds?: number;
    }>,
  ): Promise<AuthorizedMediaDelivery>;
}

export interface MediaDeliverySignerPort {
  sign(
    input: Readonly<{
      path: string;
      authorityId: string;
      audienceId: string;
      purpose: DeliveryPurpose;
      variant: DeliveryVariant;
      issuedAt: number;
      expiresAt: number;
    }>,
  ): string;
}

export class ResolveMediaDeliveryGrantHandler {
  public constructor(
    private readonly authorization: MediaDeliveryAuthorizationPort,
    private readonly signer: MediaDeliverySignerPort,
    private readonly clock: Clock,
    private readonly ttlSeconds = 60,
  ) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 300)
      throw new Error('invalid_media_grant_ttl');
  }

  public async execute(query: ResolveMediaDeliveryGrantQuery): Promise<MediaDeliveryGrant> {
    const moderation = query.purpose === 'moderation_evidence';
    if (
      (moderation && query.actor.kind !== 'admin') ||
      (!moderation && query.actor.kind !== 'user')
    )
      throw new ApplicationError('media_delivery_denied', 'error.media.delivery_denied', 403);
    const authorized = await this.authorization.authorize({
      actor: query.actor,
      photoId: query.photoId,
      purpose: query.purpose,
      requestedVariant: query.requestedVariant,
      ttlSeconds: this.ttlSeconds,
    });
    if (authorized.variantType !== query.requestedVariant)
      throw new ApplicationError('media_delivery_denied', 'error.media.delivery_denied', 403);
    const { issuedAt, expiresAt } = authorized;
    const now = Math.floor(this.clock.now().getTime() / 1000);
    if (
      !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt - issuedAt !== this.ttlSeconds ||
      issuedAt > now + 5 ||
      now >= expiresAt ||
      authorized.cachePolicy !== 'no-store'
    )
      throw new ApplicationError('media_delivery_denied', 'error.media.delivery_denied', 403);
    return {
      deliveryUrl: this.signer.sign({
        path: authorized.deliveryPath,
        authorityId: authorized.authorityId,
        audienceId: query.actor.userId,
        purpose: query.purpose,
        variant: authorized.variantType,
        issuedAt,
        expiresAt,
      }),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      variantType: authorized.variantType,
      cachePolicy: authorized.cachePolicy,
    };
  }
}
