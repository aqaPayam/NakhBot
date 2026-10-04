import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConfirmedAccountActions,
  ConfirmedPhotoActions,
  ConfirmedInternalBlocks,
  ConfirmedReviewAssignments,
  ConfirmedReviewDecisions,
  ClaimModerationReviewsHandler,
  ConfirmedSupportCommands,
  ConfirmedAppealCommands,
  AdminIngressRejectionStore,
} from '@nakh/application';
import type { AdminCommandReceipt } from '@nakh/contracts';
import { ApiExceptionFilter } from './app.js';
import {
  M7AdminModerationApiModule,
  type M7AdminModerationApiOptions,
} from './m7-admin-moderation-api.js';

const actor = { kind: 'admin' as const, userId: randomUUID() },
  headers = { authorization: 'Bearer account-admin-credential' };
const token = `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
  confirmationToken = `v1.cf.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const draft = {
  actor,
  commandId: randomUUID(),
  requestId: randomUUID(),
  commandType: 'moderation.apply-account-action' as const,
  schemaVersion: 1 as const,
  locale: 'en',
  occurredAt: new Date().toISOString(),
  idempotencyKey: randomUUID(),
  data: {
    action: 'ban_user' as const,
    adminActionToken: token,
    expectedTargetVersion: 1,
    reason: 'Private account review',
  },
};
const command = { ...draft, data: { ...draft.data, confirmationToken } };
describe('authenticated route-bound account moderation HTTP', () => {
  it('authenticates report review selection, rejects client authority/content and disables absent capability', async () => {
    const reviewId = randomUUID(),
      assigneeAdminId = randomUUID();
    const selected = { adminActionToken: token, reviewId, reviewVersion: 2, assigneeAdminId };
    const executeSelection = vi.fn<
      NonNullable<M7AdminModerationApiOptions['selectedReportReview']>['execute']
    >(() => Promise.resolve(selected));
    const { server } = await start({ selectedReportReview: { execute: executeSelection } });
    const payload = {
      actor,
      requestId: randomUUID(),
      adminActionToken: token,
      reportId: randomUUID(),
      expectedReportVersion: 3,
      action: 'assign',
    };
    const route = '/v1/admin/moderation/reports/review-selection';
    const response = await server.inject({ method: 'POST', url: route, headers, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(selected);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(executeSelection).toHaveBeenCalledWith(payload, actor);
    for (const key of [
      'reviewId',
      'expectedReviewVersion',
      'assigneeAdminId',
      'reporterId',
      'text',
    ])
      expect(
        (
          await server.inject({
            method: 'POST',
            url: route,
            headers,
            payload: { ...payload, [key]: reviewId },
          })
        ).statusCode,
      ).toBe(400);
    expect((await server.inject({ method: 'POST', url: route, payload })).statusCode).toBe(401);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: route,
          headers,
          payload: { ...payload, actor: { ...actor, userId: randomUUID() } },
        })
      ).statusCode,
    ).toBe(401);
    expect(executeSelection).toHaveBeenCalledOnce();
    executeSelection.mockResolvedValueOnce({ ...selected, ...{ text: 'Restricted evidence' } });
    const invalid = await server.inject({ method: 'POST', url: route, headers, payload });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.body).not.toContain('Restricted evidence');
    await server.close();
    app = undefined;
    const disabled = await start();
    expect(
      (await disabled.server.inject({ method: 'POST', url: route, headers, payload })).statusCode,
    ).toBe(404);
  });
  it('authenticates report account selection, rejects client authority/content and disables absent capability', async () => {
    const reviewId = randomUUID();
    const selected = { adminActionToken: token, accountVersion: 3 };
    const executeSelection = vi.fn<
      NonNullable<M7AdminModerationApiOptions['selectedReportAccount']>['execute']
    >(() => Promise.resolve(selected));
    const { server } = await start({ selectedReportAccount: { execute: executeSelection } });
    const payload = {
      actor,
      requestId: randomUUID(),
      adminActionToken: token,
      reportId: randomUUID(),
      expectedReportVersion: 3,
      action: 'restrict_user',
    };
    const route = '/v1/admin/moderation/reports/account-selection';
    const response = await server.inject({ method: 'POST', url: route, headers, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(selected);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(executeSelection).toHaveBeenCalledWith(payload, actor);
    for (const key of [
      'reviewId',
      'expectedReviewVersion',
      'targetUserId',
      'expectedAccountVersion',
      'sourceReportId',
      'reporterId',
      'text',
    ])
      expect(
        (
          await server.inject({
            method: 'POST',
            url: route,
            headers,
            payload: { ...payload, [key]: reviewId },
          })
        ).statusCode,
      ).toBe(400);
    expect((await server.inject({ method: 'POST', url: route, payload })).statusCode).toBe(401);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: route,
          headers,
          payload: { ...payload, actor: { ...actor, userId: randomUUID() } },
        })
      ).statusCode,
    ).toBe(401);
    expect(executeSelection).toHaveBeenCalledOnce();
    executeSelection.mockResolvedValueOnce({ ...selected, ...{ text: 'Restricted evidence' } });
    const invalid = await server.inject({ method: 'POST', url: route, headers, payload });
    expect(invalid.statusCode).toBe(500);
    expect(invalid.body).not.toContain('Restricted evidence');
    await server.close();
    app = undefined;
    const disabled = await start();
    expect(
      (await disabled.server.inject({ method: 'POST', url: route, headers, payload })).statusCode,
    ).toBe(404);
  });
  let app: NestFastifyApplication | undefined;
  const error = vi.fn();
  afterEach(async () => {
    await app?.close();
    app = undefined;
    error.mockClear();
  });
  async function start(
    overrides: Partial<M7AdminModerationApiOptions> = {},
    includeAccounts = true,
  ): Promise<{
    server: NestFastifyApplication;
    execute: ReturnType<typeof vi.fn<ConfirmedAccountActions['execute']>>;
    record: ReturnType<typeof vi.fn<AdminIngressRejectionStore['record']>>;
  }> {
    const execute = vi.fn<ConfirmedAccountActions['execute']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'succeeded',
        safeCode: 'account_ban_user',
        recordedAt: new Date(),
        replayed: false,
        value: {
          actionId: randomUUID(),
          targetUserId: randomUUID(),
          previousState: 'active',
          nextState: 'banned',
          accountVersion: 2,
        },
      }),
    );
    const record = vi.fn<AdminIngressRejectionStore['record']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'rejected',
        safeCode: 'invalid_request',
        recordedAt: new Date(),
        replayed: false,
        value: undefined,
      }),
    );
    app = await NestFactory.create<NestFastifyApplication>(
      M7AdminModerationApiModule.register({
        authenticator: { authenticate: () => Promise.resolve(actor) },
        ...(includeAccounts
          ? { accounts: { prepare: () => Promise.resolve(confirmationToken), execute } }
          : {}),
        journal: { record, recover: () => Promise.resolve(undefined) },
        ...overrides,
      }),
      new FastifyAdapter({ bodyLimit: 256 * 1024, trustProxy: false }),
      { logger: false },
    );
    app.useGlobalFilters(new ApiExceptionFilter({ error } as unknown as Logger));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return { server: app, execute, record };
  }
  it('requires the separate unban schema and omits internal account identities from its receipt', async () => {
    const targetUserId = randomUUID();
    const executeUnban = vi.fn<ConfirmedAppealCommands['execute']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'succeeded',
        safeCode: 'appeal_unbanned',
        recordedAt: new Date(),
        replayed: false,
        value: {
          actionId: randomUUID(),
          targetUserId,
          previousState: 'banned',
          nextState: 'active',
          accountVersion: 3,
        },
      }),
    );
    const { server, record } = await start({
      appealUnbans: { prepare: () => Promise.resolve(confirmationToken), execute: executeUnban },
    });
    const payload = {
      ...draft,
      commandType: 'moderation.unban-appeal',
      data: {
        adminActionToken: token,
        expectedTargetVersion: 2,
        expectedAccountVersion: 2,
        reason: 'Accepted appeal',
        confirmationToken,
      },
    };
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/appeals/unban',
      headers,
      payload,
    });
    expect(response.json()).toMatchObject({ result: 'succeeded', safeCode: 'completed' });
    expect(response.body).not.toContain(targetUserId);
    const missing = await server.inject({
      method: 'POST',
      url: '/v1/admin/appeals/unban',
      headers,
      payload: {
        ...payload,
        commandId: randomUUID(),
        data: {
          adminActionToken: token,
          expectedTargetVersion: 2,
          reason: 'Accepted appeal',
          confirmationToken,
        },
      },
    });
    expect(missing.json()).toMatchObject({ result: 'rejected', safeCode: 'invalid_request' });
    expect(executeUnban).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledOnce();
  });
  it('binds the appeal decision to its route and never permits an unban payload on the review endpoint', async () => {
    const executeReview = vi.fn<ConfirmedAppealCommands['execute']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'succeeded',
        safeCode: 'appeal_accepted',
        recordedAt: new Date(),
        replayed: false,
        value: {
          appealId: randomUUID(),
          status: 'accepted',
          version: 2,
          changedAt: new Date().toISOString(),
          replayed: false,
        },
      }),
    );
    const { server, record } = await start({
      appealReviews: { prepare: () => Promise.resolve(confirmationToken), execute: executeReview },
    });
    const payload = {
      ...draft,
      commandType: 'moderation.review-appeal',
      data: {
        adminActionToken: token,
        expectedTargetVersion: 1,
        reason: 'Appeal review',
        confirmationToken,
        decision: 'accepted',
        note: 'Private appeal note',
      },
    };
    const accepted = await server.inject({
      method: 'POST',
      url: '/v1/admin/appeals/review/accepted',
      headers,
      payload,
    });
    expect(accepted.json()).toMatchObject({ result: 'succeeded', safeCode: 'completed' });
    expect(accepted.body).not.toContain(payload.data.note);
    const substituted = await server.inject({
      method: 'POST',
      url: '/v1/admin/appeals/review/rejected',
      headers,
      payload: { ...payload, commandId: randomUUID() },
    });
    expect(substituted.json()).toMatchObject({ result: 'rejected', safeCode: 'invalid_request' });
    const unban = await server.inject({
      method: 'POST',
      url: '/v1/admin/appeals/review/accepted',
      headers,
      payload: { ...payload, commandId: randomUUID(), commandType: 'moderation.unban-appeal' },
    });
    expect(unban.json()).toMatchObject({ result: 'rejected', safeCode: 'invalid_request' });
    expect(executeReview).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledTimes(2);
  });
  it('binds support reply and close to their schemas, journals substitutions, and discards private workflow values', async () => {
    const executeSupport = vi.fn<ConfirmedSupportCommands['execute']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'succeeded',
        safeCode: 'support_replied',
        recordedAt: new Date(),
        replayed: false,
        value: {
          supportThreadId: randomUUID(),
          status: 'open',
          unansweredUserMessages: 0,
          version: 2,
          changedAt: new Date(),
          replayed: false,
        },
      }),
    );
    const prepare = vi.fn<ConfirmedSupportCommands['prepare']>(() =>
      Promise.resolve(confirmationToken),
    );
    const { server, record } = await start({
      supportCommands: { prepare, execute: executeSupport },
    });
    const reply = {
      ...draft,
      commandType: 'support.reply-thread',
      data: {
        adminActionToken: token,
        expectedTargetVersion: 1,
        reason: 'Support review',
        text: 'Private admin reply',
      },
    };
    const prepared = await server.inject({
      method: 'POST',
      url: '/v1/admin/support/reply/prepare',
      headers,
      payload: reply,
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepare).toHaveBeenCalledWith(reply, actor);
    const confirmed = { ...reply, data: { ...reply.data, confirmationToken } };
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/support/reply',
      headers,
      payload: confirmed,
    });
    expect(response.json()).toMatchObject({ result: 'succeeded', safeCode: 'completed' });
    expect(response.json()).not.toHaveProperty('value');
    expect(response.body).not.toContain(reply.data.text);
    const wrong = await server.inject({
      method: 'POST',
      url: '/v1/admin/support/close',
      headers,
      payload: { ...confirmed, commandId: randomUUID() },
    });
    expect(wrong.json()).toMatchObject({ result: 'rejected', safeCode: 'invalid_request' });
    expect(executeSupport).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledOnce();
  });
  it('returns only fresh bounded claims, omits replay contents, and rejects an oversized batch before delegation', async () => {
    const claims = [
      {
        reviewId: randomUUID(),
        reportId: randomUUID(),
        reviewVersion: 2,
        priority: 'threshold' as const,
      },
    ];
    const auditId = randomUUID();
    const executeClaims = vi.fn<ClaimModerationReviewsHandler['execute']>(() =>
      Promise.resolve({
        logId: auditId,
        result: 'succeeded',
        safeCode: 'reviews_claimed',
        recordedAt: new Date(),
        replayed: false,
        value: claims,
      }),
    );
    const { server, record } = await start({ reviewClaims: { execute: executeClaims } });
    const payload = {
      ...draft,
      commandType: 'moderation.claim-reviews',
      data: { adminActionToken: token, limit: 1 },
    };
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/reviews/claim',
      headers,
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ auditId, claims, replayed: false });
    expect(response.headers['cache-control']).toBe('no-store');
    executeClaims.mockResolvedValueOnce({
      logId: auditId,
      result: 'succeeded',
      safeCode: 'reviews_claimed',
      recordedAt: new Date(),
      replayed: true,
      value: claims,
    });
    const replay = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/reviews/claim',
      headers,
      payload,
    });
    expect(replay.json()).not.toHaveProperty('claims');
    const invalid = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/reviews/claim',
      headers,
      payload: { ...payload, commandId: randomUUID(), data: { ...payload.data, limit: 51 } },
    });
    expect(invalid.json()).toMatchObject({ result: 'rejected', safeCode: 'invalid_request' });
    expect(executeClaims).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledOnce();
  });
  it('prepares and delegates the exact confirmed action, returning a finite receipt without the internal account result', async () => {
    const { server, execute, record } = await start();
    const prepared = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/accounts/ban_user/prepare',
      headers,
      payload: draft,
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toEqual({ confirmationToken });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/accounts/ban_user',
      headers,
      payload: command,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<AdminCommandReceipt>()).toMatchObject({
      result: 'succeeded',
      safeCode: 'completed',
      replayed: false,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(execute).toHaveBeenCalledWith(command, actor);
    expect(record).not.toHaveBeenCalled();
    for (const restricted of [
      'targetUserId',
      'actionId',
      'accountVersion',
      actor.userId,
      draft.data.reason,
      token,
    ])
      expect(response.body).not.toContain(restricted);
  });
  it('binds photo actions to their route and returns only public receipts after delegation', async () => {
    const execute = vi.fn<ConfirmedPhotoActions['execute']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'succeeded',
        safeCode: 'photo_hide_photo',
        recordedAt: new Date(),
        replayed: false,
        value: {
          actionId: randomUUID(),
          photoId: randomUUID(),
          profileId: randomUUID(),
          targetUserId: randomUUID(),
          previousStatus: 'visible',
          nextStatus: 'hidden',
          wasPrimary: false,
          primaryPhotoId: randomUUID(),
          photoVersion: 2,
          profileVersion: 2,
          profileCompletion: 'complete',
        },
      }),
    );
    const prepare = vi.fn<ConfirmedPhotoActions['prepare']>(() =>
      Promise.resolve(confirmationToken),
    );
    const { server, record } = await start({ photos: { execute, prepare } }, false);
    const photoDraft = {
      ...draft,
      commandType: 'moderation.apply-photo-action',
      data: { ...draft.data, action: 'hide_photo' },
    };
    const prepared = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/photos/hide_photo/prepare',
      headers,
      payload: photoDraft,
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepare).toHaveBeenCalledWith(photoDraft, actor);
    const photoCommand = { ...photoDraft, data: { ...photoDraft.data, confirmationToken } };
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/photos/hide_photo',
      headers,
      payload: photoCommand,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: 'succeeded', safeCode: 'completed' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain('photoId');
    expect(execute).toHaveBeenCalledWith(photoCommand, actor);
    const mismatch = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/photos/delete_photo',
      headers,
      payload: photoCommand,
    });
    expect(mismatch.json()).toMatchObject({ result: 'rejected' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0].requiredPermission).toBe('delete_photo');
  });
  it('binds internal block changes to signed server-held pairs and hides their effect references', async () => {
    const execute = vi.fn<ConfirmedInternalBlocks['execute']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'succeeded',
        safeCode: 'internal_block_created',
        recordedAt: new Date(),
        replayed: false,
        value: {
          actionId: randomUUID(),
          userLowId: randomUUID(),
          userHighId: randomUUID(),
          previousState: 'matched',
          nextState: 'blocked',
          pairVersion: 2,
          closedMatchId: randomUUID(),
          closedChatSessionId: randomUUID(),
          closedLikeCount: 2,
          revokedUnlockCount: 0,
        },
      }),
    );
    const prepare = vi.fn<ConfirmedInternalBlocks['prepare']>(() =>
      Promise.resolve(confirmationToken),
    );
    const { server, record } = await start({ internalBlocks: { execute, prepare } }, false);
    const blockDraft = {
      ...draft,
      commandType: 'moderation.change-internal-block',
      data: { ...draft.data, action: 'create' },
    };
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/internal-blocks/create/prepare',
          headers,
          payload: blockDraft,
        })
      ).statusCode,
    ).toBe(200);
    expect(prepare).toHaveBeenCalledWith(blockDraft, actor);
    const blockCommand = { ...blockDraft, data: { ...blockDraft.data, confirmationToken } };
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/internal-blocks/create',
      headers,
      payload: blockCommand,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: 'succeeded', safeCode: 'completed' });
    expect(execute).toHaveBeenCalledWith(blockCommand, actor);
    for (const privateField of ['userLowId', 'userHighId', 'closedMatchId', 'closedChatSessionId'])
      expect(response.body).not.toContain(privateField);
    const forged = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/internal-blocks/create',
      headers,
      payload: {
        ...blockCommand,
        data: { ...blockCommand.data, userLowId: randomUUID(), userHighId: randomUUID() },
      },
    });
    expect(forged.json()).toMatchObject({ result: 'rejected' });
    const mismatch = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/internal-blocks/remove',
      headers,
      payload: blockCommand,
    });
    expect(mismatch.json()).toMatchObject({ result: 'rejected' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(2);
    expect(
      record.mock.calls.every(([input]) => input.requiredPermission === 'manage_internal_blocks'),
    ).toBe(true);
  });
  it('confirms review assignment while omitting assignee and report references from its receipt', async () => {
    const execute = vi.fn<ConfirmedReviewAssignments['execute']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'succeeded',
        safeCode: 'review_assigned',
        recordedAt: new Date(),
        replayed: false,
        value: {
          reviewId: randomUUID(),
          reportId: randomUUID(),
          assignedAdminId: randomUUID(),
          reviewVersion: 2,
        },
      }),
    );
    const prepare = vi.fn<ConfirmedReviewAssignments['prepare']>(() =>
      Promise.resolve(confirmationToken),
    );
    const { server, record } = await start({ reviewAssignments: { execute, prepare } }, false);
    const assignmentDraft = {
      ...draft,
      commandType: 'moderation.assign-review',
      data: {
        adminActionToken: draft.data.adminActionToken,
        expectedTargetVersion: draft.data.expectedTargetVersion,
        reason: draft.data.reason,
        assigneeAdminId: randomUUID(),
      },
    };
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/reviews/assignment/prepare',
          headers,
          payload: assignmentDraft,
        })
      ).statusCode,
    ).toBe(200);
    expect(prepare).toHaveBeenCalledWith(assignmentDraft, actor);
    const assigned = { ...assignmentDraft, data: { ...assignmentDraft.data, confirmationToken } };
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/reviews/assignment',
      headers,
      payload: assigned,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: 'succeeded', safeCode: 'completed' });
    expect(execute).toHaveBeenCalledWith(assigned, actor);
    for (const privateField of [
      'assignedAdminId',
      'reviewId',
      'reportId',
      assignmentDraft.data.assigneeAdminId,
    ])
      expect(response.body).not.toContain(privateField);
    const malformed = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/reviews/assignment',
      headers,
      payload: { ...assigned, data: { ...assigned.data, permissions: ['view_reports'] } },
    });
    expect(malformed.json()).toMatchObject({ result: 'rejected' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0].requiredPermission).toBe('view_reports');
  });
  it('binds review decisions and private notes to confirmation without returning effect details', async () => {
    const execute = vi.fn<ConfirmedReviewDecisions['execute']>(() =>
      Promise.resolve({
        logId: randomUUID(),
        result: 'succeeded',
        safeCode: 'review_dismissed',
        recordedAt: new Date(),
        replayed: false,
        value: { reviewId: randomUUID(), reportId: randomUUID(), status: 'dismissed', version: 3 },
      }),
    );
    const prepare = vi.fn<ConfirmedReviewDecisions['prepare']>(() =>
      Promise.resolve(confirmationToken),
    );
    const { server, record } = await start({ reviewDecisions: { execute, prepare } }, false);
    const privateNote = 'PRIVATE REVIEW NOTE';
    const decisionDraft = {
      ...draft,
      commandType: 'moderation.decide-review',
      data: {
        adminActionToken: draft.data.adminActionToken,
        expectedTargetVersion: 2,
        reason: draft.data.reason,
        decision: 'dismissed',
        note: privateNote,
      },
    };
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/reviews/decision/dismissed/prepare',
          headers,
          payload: decisionDraft,
        })
      ).statusCode,
    ).toBe(200);
    expect(prepare).toHaveBeenCalledWith(decisionDraft, actor);
    const decisionCommand = {
      ...decisionDraft,
      data: { ...decisionDraft.data, confirmationToken },
    };
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/reviews/decision/dismissed',
      headers,
      payload: decisionCommand,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: 'succeeded', safeCode: 'completed' });
    expect(execute).toHaveBeenCalledWith(decisionCommand, actor);
    for (const privateValue of [privateNote, 'reportId', 'reviewId', draft.data.reason])
      expect(response.body).not.toContain(privateValue);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/reviews/decision/actioned',
          headers,
          payload: { ...decisionCommand, commandId: randomUUID() },
        })
      ).json(),
    ).toMatchObject({ result: 'rejected' });
    expect(record.mock.calls[0]?.[0].requiredPermission).toBe('view_reports');
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/reviews/decision/dismissed',
          headers,
          payload: {
            ...decisionCommand,
            commandId: randomUUID(),
            data: { ...decisionCommand.data, note: 'x'.repeat(2001) },
          },
        })
      ).json(),
    ).toMatchObject({ result: 'rejected' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(record.mock.calls)).not.toContain(privateNote);
  });
  it('rejects a mismatched route action and audits only the server-selected permission before delegation', async () => {
    const { server, execute, record } = await start();
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/accounts/unban_user/prepare',
          headers,
          payload: draft,
        })
      ).statusCode,
    ).toBe(400);
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/accounts/unban_user',
      headers,
      payload: command,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: 'rejected', safeCode: 'invalid_request' });
    expect(execute).not.toHaveBeenCalled();
    expect(record.mock.calls[0]?.[0].requiredPermission).toBe('unban_user');
    expect(JSON.stringify(record.mock.calls)).not.toContain(draft.data.reason);
  });
  it('audits malformed authenticated requests and fails closed when the required journal fails', async () => {
    const { server, execute, record } = await start();
    const invalid = {
      ...command,
      actor: { ...actor, userId: randomUUID() },
      targetUserId: randomUUID(),
    };
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/accounts/ban_user',
          headers,
          payload: invalid,
        })
      ).json(),
    ).toMatchObject({ result: 'rejected' });
    expect(execute).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    record.mockRejectedValueOnce(new Error('PRIVATE DATABASE ERROR'));
    const failed = await server.inject({
      method: 'POST',
      url: '/v1/admin/moderation/accounts/ban_user',
      headers,
      payload: {},
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('PRIVATE');
    expect(JSON.stringify(error.mock.calls)).not.toContain('PRIVATE');
  });
  it('keeps missing capabilities unavailable and rejects the wrong authentication audience without auditing', async () => {
    const { server, execute, record } = await start({
      authenticator: {
        authenticate: () => Promise.resolve({ kind: 'user', userId: actor.userId }),
      },
    });
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/accounts/ban_user',
          headers,
          payload: command,
        })
      ).statusCode,
    ).toBe(401);
    expect(execute).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/accounts/unknown',
          headers,
          payload: command,
        })
      ).statusCode,
    ).toBe(404);
    await server.close();
    app = undefined;
    const disabled = await start({}, false);
    expect(
      (
        await disabled.server.inject({
          method: 'POST',
          url: '/v1/admin/moderation/accounts/ban_user',
          headers,
          payload: command,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('sanitizes malformed JSON and oversized bodies before authenticated command delegation', async () => {
    const { server, execute, record } = await start();
    const privateValue = 'PRIVATE PARSER INPUT';
    for (const [payload, status] of [
      [`{"text":"${privateValue}"`, 400],
      [JSON.stringify({ text: privateValue.repeat(20000) }), 413],
    ] as const) {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/admin/moderation/accounts/ban_user',
        headers: { ...headers, 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain(privateValue);
      expect(JSON.stringify(error.mock.calls)).not.toContain(privateValue);
      expect(JSON.stringify(error.mock.calls)).not.toContain(headers.authorization);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
