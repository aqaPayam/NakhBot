import { createHash } from 'node:crypto';
import { ApplicationError, SystemClock } from '@nakh/domain';
import {
  GetLockedLikedByPageHandler,
  SessionLikedByOpaqueReferences,
  ResolveMediaDeliveryGrantHandler,
  type EnsureBlurredPreview,
  type MediaDeliverySignerPort,
  type OpaqueTokenStore,
  type UserProductLife,
  type UserSessionActor,
} from '@nakh/application';
import {
  PostgresLikedByStore,
  PostgresLikedByMediaAuthorization,
  PostgresLikedByProfileStore,
  type NakhDatabase,
  type ClaimedTelegramLikedByDelivery,
  type PostgresTelegramLikedByDeliveryStore,
  type MediaSourceAuthorityQuery,
} from '@nakh/persistence-postgres';
import {
  SignupNavigationTokens,
  TelegramLockedLikedByPresenter,
  TelegramCandidateSendFailure,
  TelegramLikedBySendFailure,
  fullProfileTextParts,
  type TelegramCandidateMediaRelay,
  type TelegramLockedLikedByMediaRelay,
  type TelegramLockedLikedByScreenRelay,
  type SignupNavigation,
} from '@nakh/telegram';
import {
  ResumableTelegramLikedBySender,
  type TelegramLikedByRendererProvider,
} from './liked-by-resumable-sender.js';
import { TelegramLikedByLeaseLost } from './liked-by-delivery-processor.js';

type Dependencies = Readonly<{
  database: NakhDatabase;
  environment: 'development' | 'test' | 'staging' | 'production';
  owner: string;
  botId: string;
  actionKey: Uint8Array;
  mediaOrigin: string;
  reportsEnabled: boolean;
  tokens: (life: UserProductLife) => OpaqueTokenStore;
  signer: MediaDeliverySignerPort;
  blur: Pick<EnsureBlurredPreview, 'execute'>;
  store: Pick<
    PostgresTelegramLikedByDeliveryStore,
    'loadRecordedMessageKeys' | 'recordMessageReceipt' | 'bindProfileVersion'
  >;
  renderers: TelegramLikedByRendererProvider;
  screens: Pick<TelegramLockedLikedByScreenRelay, 'sendScreen' | 'sendPrivateText'>;
  cards: Pick<TelegramLockedLikedByMediaRelay, 'sendCard'>;
  photos: Pick<TelegramCandidateMediaRelay, 'send'>;
}>;
function denied(): never {
  throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 403);
}
function group(key: string): string {
  return createHash('sha256').update(key).digest().subarray(0, 12).toString('base64url');
}
function receiptKey(delivery: string, version: number, kind: string, index: number): string {
  return (
    'detail:' +
    createHash('sha256')
      .update(JSON.stringify(['liked-by-full-profile-v1', delivery, version, kind, index]))
      .digest('base64url')
  );
}
/** Every invocation owns its ephemeral graph. No profile body, issued media URL,
 * callback closure or newer user session is persisted in the handoff. */
export function createLikedByCustomerDelivery(
  input: Dependencies,
): (delivery: ClaimedTelegramLikedByDelivery) => Promise<void> {
  const lockedSender = new ResumableTelegramLikedBySender(
    input.store,
    input.renderers,
    input.screens,
    input.cards,
  );
  return async (claimed) => {
    const delivery = Object.freeze({ ...claimed });
    if (!delivery.sessionGrantId || delivery.botId !== input.botId) denied();
    const actor: UserSessionActor = Object.freeze({
      kind: 'user',
      userId: delivery.viewerUserId,
      productEpoch: delivery.productEpoch,
      sessionGrantId: delivery.sessionGrantId,
    });
    const settlement = { id: delivery.id, owner: input.owner, attemptCount: delivery.attemptCount };
    const references = SessionLikedByOpaqueReferences.forLife(
      input.tokens(actor),
      input.actionKey,
      actor,
    ).forSession(actor);
    const nav = new SignupNavigationTokens(
      input.tokens(actor),
      input.actionKey,
      input.botId,
      delivery.telegramUserId,
      actor,
      undefined,
      'liked_by',
    );
    const render = await input.renderers.rendererFor(actor.userId);
    const t = (key: string, variables: Record<string, string | number> = {}): string =>
      render({ key, variables });
    const query = {
      actor: { kind: 'user' as const, userId: actor.userId },
      requestId: delivery.requestId,
      limit: 8,
    };
    const current = async (): Promise<void> => {
      if ((await input.store.loadRecordedMessageKeys(settlement)) === undefined)
        throw new TelegramLikedByLeaseLost();
      // Reuse the same native inbox capability and READ ONLY original-grant check.
      await new PostgresLikedByStore(input.database, actor).readActionablePage(
        { ...query, limit: 1 },
        undefined,
        actor.productEpoch,
      );
    };
    const base: SignupNavigation = {
      actor,
      version: delivery.profileVersion ?? 1,
      screen: 'liked_by',
      action: 'resume',
      group: group(delivery.id),
    };
    const button = async (
      text: string,
      action: SignupNavigation['action'],
      extra: Partial<SignupNavigation> = {},
      part = 'root',
    ): Promise<{ text: string; callback_data: string }> => ({
      text,
      callback_data: await nav.stableButton(
        { ...base, action, ...extra },
        `${delivery.id}:${part}:${action}`,
      ),
    });
    await current();
    if (delivery.featureUnlockId === undefined) {
      if (delivery.sourceLikeId !== undefined || delivery.profileVersion !== undefined) denied();
      const sources = new Map<
        string,
        { authority: PostgresLikedByMediaAuthorization; source: MediaSourceAuthorityQuery }
      >();
      const grantsForLike = (likeId: string): ResolveMediaDeliveryGrantHandler => {
        const authority = new PostgresLikedByMediaAuthorization(
          input.database,
          input.environment,
          actor,
          likeId,
        );
        return new ResolveMediaDeliveryGrantHandler(
          {
            authorize: async (request) => {
              const grant = await authority.authorize(request);
              sources.set(likeId, {
                authority,
                source: {
                  authorityId: grant.authorityId,
                  audienceId: actor.userId,
                  path: grant.deliveryPath,
                  purpose: 'liked_by_blur',
                  variant: 'blurred_preview',
                  issuedAt: grant.issuedAt,
                  expiresAt: grant.expiresAt,
                },
              });
              return grant;
            },
          },
          input.signer,
          new SystemClock(),
        );
      };
      const handler = new GetLockedLikedByPageHandler(
        new PostgresLikedByStore(input.database, actor),
        { forLife: () => references },
        input.blur,
        {
          execute: () =>
            Promise.reject(new ApplicationError('internal_error', 'error.internal', 500)),
        },
        grantsForLike,
      );
      const page = await handler.execute(
        { ...query, ...(delivery.cursor === undefined ? {} : { cursor: delivery.cursor }) },
        actor.productEpoch,
      );
      const screen = new TelegramLockedLikedByPresenter(input.mediaOrigin).present(page);
      const home = await button(t('account.menu.home'), 'home');
      await lockedSender.send({
        deliveryId: delivery.id,
        owner: input.owner,
        attemptCount: delivery.attemptCount,
        botId: input.botId,
        viewerUserId: actor.userId,
        telegramUserId: delivery.telegramUserId,
        screen: {
          ...screen,
          home: {
            label: { key: 'account.menu.home', variables: {} },
            callbackData: home.callback_data,
          },
        },
        beforeSend: async (token) => {
          await current();
          if (token !== undefined) {
            const likeId = await references.resolveAction(token, actor.userId),
              source = likeId === undefined ? undefined : sources.get(likeId);
            if (!source || !(await source.authority.isCurrent(source.source))) denied();
          }
        },
      });
      return;
    }
    if (!delivery.sourceLikeId || delivery.cursor !== undefined) denied();
    const store = new PostgresLikedByProfileStore(input.database, input.environment, actor, 300),
      profile = await store.detail(delivery.featureUnlockId);
    if (profile.telegramUserId !== delivery.telegramUserId) denied();
    const frozen = await input.store.bindProfileVersion(settlement, profile.profileVersion);
    if (frozen === 'lease_lost') throw new TelegramLikedByLeaseLost();
    if (
      frozen !== 'bound' ||
      (delivery.profileVersion !== undefined && delivery.profileVersion !== profile.profileVersion)
    )
      denied();
    const profileCurrent = async (): Promise<boolean> => {
      await current();
      return store.detailIsCurrent(delivery.featureUnlockId!, profile);
    };
    const selectors = {
      screen: 'profile',
      version: profile.profileVersion,
      likeId: delivery.sourceLikeId,
      unlockId: delivery.featureUnlockId,
    };
    const reportNav = new SignupNavigationTokens(
      input.tokens(actor),
      input.actionKey,
      input.botId,
      delivery.telegramUserId,
      actor,
      undefined,
      'report',
    );
    const report = async (photoId?: string): Promise<{ text: string; callback_data: string }> => ({
      text: t('report.title'),
      callback_data: await reportNav.stableButton(
        {
          actor,
          version: 1,
          screen: 'report',
          action: 'begin',
          code: delivery.sourceLikeId,
          field: 'received_like',
          group: group(delivery.id + ':report:' + (photoId ?? 'profile')),
          ...(photoId === undefined ? {} : { photoId }),
        },
        `${delivery.id}:report:${photoId ?? 'profile'}`,
      ),
    });
    const keyboard = [
      [
        await button(t('liked_by.like_back'), 'like', selectors),
        await button(t('liked_by.dismiss'), 'reject', selectors),
      ],
      ...(input.reportsEnabled ? [[await report()]] : []),
      [await button(t('liked_by.back'), 'resume')],
      [await button(t('account.menu.home'), 'home')],
    ];
    const recorded = await input.store.loadRecordedMessageKeys(settlement);
    if (recorded === undefined) throw new TelegramLikedByLeaseLost();
    const known = new Set(recorded);
    const record = async (key: string, id: number): Promise<void> => {
      const result = await input.store.recordMessageReceipt({
        ...settlement,
        messageKey: key,
        providerMessageId: id,
      });
      if (result.outcome === 'lease_lost') throw new TelegramLikedByLeaseLost();
      known.add(key);
    };
    for (const [index, photo] of profile.photos.entries()) {
      const key = receiptKey(delivery.id, profile.profileVersion, 'photo', index);
      if (known.has(key)) continue;
      if (!(await profileCurrent())) denied();
      try {
        const id = await input.photos.send(
          {
            viewerUserId: actor.userId,
            telegramUserId: delivery.telegramUserId,
            caption: t('profile.ui.photo', {
              name: profile.name,
              position: index + 1,
              total: profile.photos.length,
            }),
            keyboard: [
              ...keyboard.slice(0, 1),
              ...(input.reportsEnabled ? [[await report(photo.photoId)]] : []),
              ...keyboard.slice(input.reportsEnabled ? 2 : 1),
            ],
            protectContent: true,
            photo: {
              variantType: 'thumbnail',
              cachePolicy: 'no-store',
              expiresAt: new Date(photo.authority.expiresAt * 1000).toISOString(),
              deliveryUrl: input.signer.sign({
                authorityId: photo.authority.authorityId,
                audienceId: actor.userId,
                path: photo.authority.deliveryPath,
                purpose: 'profile_detail',
                variant: 'thumbnail',
                issuedAt: photo.authority.issuedAt,
                expiresAt: photo.authority.expiresAt,
              }),
            },
          },
          profileCurrent,
        );
        await record(key, Number(id));
      } catch (error) {
        if (error instanceof TelegramCandidateSendFailure) {
          if (error.code === 'not_started') denied();
          throw new TelegramLikedBySendFailure(
            error.code === 'provider_rejected'
              ? 'provider_rejected'
              : error.code === 'media_unavailable'
                ? 'media_unavailable'
                : 'provider_unavailable',
          );
        }
        throw error;
      }
    }
    for (const [index, text] of fullProfileTextParts(profile, t).entries()) {
      const key = receiptKey(delivery.id, profile.profileVersion, 'text', index);
      if (known.has(key)) continue;
      if (!(await profileCurrent())) denied();
      const id = await input.screens.sendPrivateText({
        botId: input.botId,
        telegramUserId: delivery.telegramUserId,
        text,
        keyboard,
      });
      await record(key, id);
    }
  };
}
