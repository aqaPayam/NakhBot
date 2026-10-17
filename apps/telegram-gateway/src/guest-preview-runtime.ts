import type { MediaDeliverySignerPort, UserSessionActor } from '@nakh/application';
import type { AppConfig } from '@nakh/config';
import { resolveSecretReference } from '@nakh/config';
import {
  HmacMediaAudienceCredentials,
  HmacMediaDeliveryTokens,
  MediaDeliveryUrlSigner,
} from '@nakh/media-delivery';
import {
  PostgresCandidateReservationStore,
  PostgresCandidateDeliveryStore,
  PostgresCandidatePresentationStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import {
  TelegramCandidateMediaRelay,
  TelegramCandidateSendFailure,
  type TelegramCandidateCard,
} from '@nakh/telegram';
import { randomUUID } from 'node:crypto';
import { ApplicationError } from '@nakh/domain';
import { M1Metrics, M1_REASON_CODES } from '@nakh/observability';

export interface GuestPreviewRuntimePort {
  show(
    input: Readonly<{
      actor: UserSessionActor;
      telegramUserId: string;
      requestId: string;
      keyboard: TelegramCandidateCard['keyboard'];
      detailButton?: (
        deliveryId: string,
      ) => Promise<Readonly<{ text: string; callback_data: string }>>;
      render: (key: string, variables: Record<string, string | number>) => string;
    }>,
  ): Promise<'sent' | 'empty' | 'delivered' | 'failed' | 'pending'>;
  detail?(
    input: Readonly<{
      actor: UserSessionActor;
      telegramUserId: string;
      deliveryId: string;
      keyboard: TelegramCandidateCard['keyboard'];
      render: (key: string, variables: Record<string, string | number>) => string;
      sendText: (text: string) => Promise<void>;
    }>,
  ): Promise<void>;
}
export class GuestPreviewRuntime implements GuestPreviewRuntimePort {
  private readonly metrics = new M1Metrics();
  public constructor(
    private readonly database: NakhDatabase,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
    private readonly relay: Pick<TelegramCandidateMediaRelay, 'send'>,
    private readonly signer: MediaDeliverySignerPort,
  ) {}
  public async show(
    input: Parameters<GuestPreviewRuntimePort['show']>[0],
  ): ReturnType<GuestPreviewRuntimePort['show']> {
    const at = performance.now();
    try {
      const result = await this.deliver(input);
      this.metrics.recordHandler(
        'guest_preview_consume',
        result === 'delivered'
          ? 'replay'
          : result === 'pending' || result === 'failed'
            ? 'failure'
            : 'success',
        performance.now() - at,
        result === 'pending' || result === 'failed' ? 'dependency_unavailable' : 'none',
      );
      if (result === 'sent') this.metrics.recordGuestPreview('consumed');
      return result;
    } catch (error) {
      const reason =
        error instanceof ApplicationError
          ? (M1_REASON_CODES.find((code) => code === error.code) ?? 'invalid_request')
          : 'dependency_unavailable';
      this.metrics.recordHandler(
        'guest_preview_consume',
        error instanceof ApplicationError && error.status < 500 ? 'denied' : 'failure',
        performance.now() - at,
        reason,
      );
      if (reason === 'guest_preview_limit_reached') this.metrics.recordGuestPreview('denied');
      throw error;
    }
  }
  public async detail(
    input: Parameters<NonNullable<GuestPreviewRuntimePort['detail']>>[0],
  ): Promise<void> {
    const actor = Object.freeze({ ...input.actor }),
      deliveryId = input.deliveryId,
      telegramUserId = input.telegramUserId,
      keyboard = structuredClone(input.keyboard),
      render = input.render,
      sendText = input.sendText;
    const store = new PostgresCandidatePresentationStore(this.database, this.environment, actor);
    const profile = await store.detail(deliveryId);
    if (profile.telegramUserId !== telegramUserId)
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const current = (): Promise<boolean> => store.detailIsCurrent(deliveryId, profile);
    const label = (key: string): string => render(key, {});
    const text = render('profile.ui.details', {
      name: profile.name,
      age: profile.age,
      location: profile.locationLabelKeys.map(label).join(', '),
      gender: label(profile.genderLabelKey),
      preference: label(profile.preferenceLabelKey),
      goal: label(profile.goalLabelKey),
      interests: profile.interestLabelKeys.map(label).join(', '),
      highlight: profile.highlight,
      bio: profile.bio,
      optional: profile.optional
        .map((o) =>
          render('profile.ui.optional', {
            label: label(o.labelKey),
            value:
              typeof o.value === 'string' || typeof o.value === 'number'
                ? o.value
                : o.value.map(label).join(', '),
          }),
        )
        .join('\n'),
    });
    if (text.length < 1 || text.length > 16000)
      throw new ApplicationError('internal_error', 'error.identity.user_context_invalid', 500);
    for (const [position, photo] of profile.photos.entries())
      await this.relay.send(
        {
          viewerUserId: actor.userId,
          telegramUserId,
          keyboard,
          caption: render('profile.ui.photo', {
            name: profile.name,
            position: position + 1,
            total: profile.photos.length,
          }),
          photo: {
            variantType: 'thumbnail',
            cachePolicy: 'no-store',
            expiresAt: new Date(photo.authority.expiresAt * 1000).toISOString(),
            deliveryUrl: this.signer.sign({
              path: photo.authority.deliveryPath,
              authorityId: photo.authority.authorityId,
              audienceId: actor.userId,
              purpose: 'profile_detail',
              variant: 'thumbnail',
              issuedAt: photo.authority.issuedAt,
              expiresAt: photo.authority.expiresAt,
            }),
          },
        },
        current,
      );
    const chunks: string[] = [];
    let chunk = '';
    for (const point of text) {
      if (chunk.length + point.length > 3500) {
        chunks.push(chunk);
        chunk = '';
      }
      chunk += point;
    }
    if (chunk) chunks.push(chunk);
    for (const part of chunks) {
      if (!(await current()))
        throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
      await sendText(part);
    }
  }
  private async deliver(
    input: Parameters<GuestPreviewRuntimePort['show']>[0],
  ): ReturnType<GuestPreviewRuntimePort['show']> {
    const actor = Object.freeze({ ...input.actor }),
      keyboard = structuredClone(input.keyboard),
      telegramUserId = input.telegramUserId,
      requestId = input.requestId,
      render = input.render,
      detailButton = input.detailButton;
    const reservation = await new PostgresCandidateReservationStore(
      this.database,
      actor,
    ).reserveNext(
      { actor: { kind: 'user', userId: actor.userId }, requestId, mode: 'guest_preview' },
      { deliveryId: randomUUID(), eventId: randomUUID(), reservedAt: new Date() },
    );
    if (reservation === undefined) return 'empty';
    const presentation = new PostgresCandidatePresentationStore(
      this.database,
      this.environment,
      actor,
    );
    let started = false,
      providerMessageId: string;
    const deliveries = new PostgresCandidateDeliveryStore(this.database);
    try {
      const card = await presentation.load(reservation.deliveryId);
      if (card.state !== 'ready') return card.state;
      if (card.telegramUserId !== telegramUserId)
        throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
      providerMessageId = await this.relay.send(
        {
          viewerUserId: actor.userId,
          telegramUserId,
          keyboard: detailButton
            ? [...keyboard, [await detailButton(reservation.deliveryId)]]
            : keyboard,
          caption: render('preview.ui.card', {
            name: card.name,
            age: card.age,
            city: render(card.cityLabelKey, {}),
            highlight: card.highlight,
          }),
          photo: {
            variantType: 'thumbnail',
            cachePolicy: 'no-store',
            expiresAt: new Date(card.authority.expiresAt * 1000).toISOString(),
            deliveryUrl: this.signer.sign({
              path: card.authority.deliveryPath,
              authorityId: card.authority.authorityId,
              audienceId: actor.userId,
              purpose: 'profile_card',
              variant: 'thumbnail',
              issuedAt: card.authority.issuedAt,
              expiresAt: card.authority.expiresAt,
            }),
          },
        },
        async () => {
          started = await presentation.begin(
            reservation.deliveryId,
            card.source,
            card.profileVersion,
          );
          return started;
        },
      );
    } catch (error) {
      if (error instanceof ApplicationError && error.status === 401) throw error;
      if (
        !started ||
        (error instanceof TelegramCandidateSendFailure && error.code === 'provider_rejected')
      ) {
        try {
          await deliveries.recordDefinitiveFailure(
            {
              deliveryId: reservation.deliveryId,
              reasonCode: started ? 'provider_rejected' : 'source_unavailable',
              onlyIfUnstarted: !started,
            },
            { auditId: randomUUID(), eventId: randomUUID(), processedAt: new Date() },
          );
          return 'failed';
        } catch {
          return 'pending';
        }
      }
      // No timeout, expiry or malformed acknowledgement proves non-delivery.
      return 'pending';
    }
    try {
      await deliveries.recordDelivered(
        { deliveryId: reservation.deliveryId, providerMessageId },
        {
          auditId: randomUUID(),
          deliveryEventId: randomUUID(),
          consumptionEventId: randomUUID(),
          processedAt: new Date(),
        },
      );
      return 'sent';
    } catch {
      return 'pending';
    }
  }
}
export function createGuestPreviewRuntime(
  config: AppConfig,
  database: NakhDatabase,
  resolve: (reference: string) => string = resolveSecretReference,
): GuestPreviewRuntimePort | undefined {
  if (!config.telegram.guestPreviewEnabled) return undefined;
  const key = (reference: string): Buffer => {
    const encoded = resolve(reference),
      bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length < 32 || bytes.length > 64 || bytes.toString('base64url') !== encoded)
      throw new Error('Candidate delivery credentials unavailable.');
    return bytes;
  };
  const signing = key(config.media.signingKeyRef),
    audience = key(config.media.audienceKeyRef);
  if (signing.equals(audience)) throw new Error('Candidate signing and audience keys must differ.');
  const origin = `https://${config.media.cdnHost}`;
  return new GuestPreviewRuntime(
    database,
    config.environment === 'local' ? 'development' : config.environment,
    new TelegramCandidateMediaRelay(
      origin,
      resolve(config.telegram.botTokenRef),
      new HmacMediaAudienceCredentials(origin, {
        currentKeyId: config.media.audienceKeyId,
        keys: new Map([[config.media.audienceKeyId, audience]]),
      }),
    ),
    new MediaDeliveryUrlSigner(
      origin,
      new HmacMediaDeliveryTokens({
        currentKeyId: config.media.signingKeyId,
        keys: new Map([[config.media.signingKeyId, signing]]),
      }),
    ),
  );
}
