import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  ApplicationError,
  M7_PERMISSIONS,
  evaluateAdminPermission,
  type Actor,
  type M7Permission,
} from '@nakh/domain';

import type { OpaqueTokenStore } from '../security/opaque-token.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TELEGRAM_USER_ID = /^[1-9][0-9]{0,19}$/u;
const COMMAND_CODE = /^[a-z][a-z0-9.-]{0,119}$/u;
const TARGET_TYPE = /^[a-z][a-z0-9_]{0,79}$/u;
const TOKEN_ID = /^[A-Za-z0-9_-]{16}$/u;
const TOKEN = /^(v1\.ad\.([A-Za-z0-9_-]{16}))\.([A-Za-z0-9_-]{16})$/u;
const permissionCodes = new Set<string>(M7_PERMISSIONS);

export type AdminAuthorizationFacts = Readonly<{
  adminUserId: string;
  actorUserId: string;
  adminActive: boolean;
  activePermissions: readonly M7Permission[];
}>;

export interface AdminAuthorizationStore {
  loadByTelegramIdentity(
    input: Readonly<{
      actorUserId: string;
      telegramUserId: string;
    }>,
  ): Promise<AdminAuthorizationFacts | undefined>;
  loadCurrent(
    input: Readonly<{
      adminUserId: string;
      actorUserId: string;
    }>,
  ): Promise<AdminAuthorizationFacts | undefined>;
}

export type AdminActionScope = Readonly<{
  commandCode: string;
  requiredPermission: M7Permission;
  targetType: string;
  targetId: string | null;
  expectedTargetVersion: number | null;
}>;

export type AuthorizedAdminAction = AdminActionScope &
  Readonly<{
    adminUserId: string;
    actorUserId: string;
  }>;

type StoredAdminAction = AdminActionScope &
  Readonly<{
    version: 1;
    purpose: 'admin_action';
    adminUserId: string;
    actorUserId: string;
    expiresAt: number;
  }>;

function isPermission(value: unknown): value is M7Permission {
  return typeof value === 'string' && permissionCodes.has(value);
}

function validFacts(value: AdminAuthorizationFacts | undefined): value is AdminAuthorizationFacts {
  return (
    value !== undefined &&
    UUID.test(value.adminUserId) &&
    UUID.test(value.actorUserId) &&
    typeof value.adminActive === 'boolean' &&
    Array.isArray(value.activePermissions) &&
    value.activePermissions.every(isPermission)
  );
}

function validScope(value: AdminActionScope): boolean {
  return (
    COMMAND_CODE.test(value.commandCode) &&
    isPermission(value.requiredPermission) &&
    TARGET_TYPE.test(value.targetType) &&
    (value.targetId === null || UUID.test(value.targetId)) &&
    (value.expectedTargetVersion === null ||
      (Number.isSafeInteger(value.expectedTargetVersion) && value.expectedTargetVersion >= 1))
  );
}

function validStoredState(value: unknown): value is StoredAdminAction {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(state).length === 10 &&
    state.version === 1 &&
    state.purpose === 'admin_action' &&
    typeof state.adminUserId === 'string' &&
    UUID.test(state.adminUserId) &&
    typeof state.actorUserId === 'string' &&
    UUID.test(state.actorUserId) &&
    typeof state.commandCode === 'string' &&
    typeof state.targetType === 'string' &&
    (state.targetId === null ||
      (typeof state.targetId === 'string' && UUID.test(state.targetId))) &&
    (state.expectedTargetVersion === null ||
      (typeof state.expectedTargetVersion === 'number' &&
        Number.isSafeInteger(state.expectedTargetVersion) &&
        state.expectedTargetVersion >= 1)) &&
    isPermission(state.requiredPermission) &&
    typeof state.expiresAt === 'number' &&
    Number.isSafeInteger(state.expiresAt) &&
    validScope(state as StoredAdminAction)
  );
}

function invalidScope(): ApplicationError {
  return new ApplicationError('invalid_request', 'error.admin.action_scope_invalid', 400);
}

function denied(): ApplicationError {
  return new ApplicationError('forbidden', 'error.admin.unauthorized', 403);
}

/**
 * Issues and resolves short signed references after a trusted Telegram identity has been mapped to
 * an AdminUser. The token carries only internal IDs and one exact permission/target scope. Current
 * PostgreSQL authorization is reloaded on every resolution, so disablement and role changes take
 * effect immediately and role names can never become an authorization bypass.
 */
export class AdminActionAuthorizationService {
  private readonly key: Uint8Array;

  public constructor(
    private readonly authorization: AdminAuthorizationStore,
    private readonly tokens: OpaqueTokenStore,
    key: Uint8Array,
    private readonly now: () => number = Date.now,
    private readonly randomId: () => string = () => randomBytes(12).toString('base64url'),
  ) {
    if (key.byteLength < 32) throw new Error('Admin action-token key is invalid.');
    this.key = Uint8Array.from(key);
  }

  private signature(unsigned: string): string {
    return createHmac('sha256', this.key)
      .update(unsigned)
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  }

  private token(id: string): string {
    const unsigned = `v1.ad.${id}`;
    return `${unsigned}.${this.signature(unsigned)}`;
  }

  private authorizeFacts(
    facts: AdminAuthorizationFacts | undefined,
    actorUserId: string,
    requiredPermission: M7Permission,
    adminUserId?: string,
  ): AdminAuthorizationFacts {
    if (
      !validFacts(facts) ||
      facts.actorUserId !== actorUserId ||
      (adminUserId !== undefined && facts.adminUserId !== adminUserId)
    )
      throw denied();
    const decision = evaluateAdminPermission({
      adminActive: facts.adminActive,
      requiredPermission,
      activePermissions: new Set(facts.activePermissions),
    });
    if (!decision.allowed) throw denied();
    return facts;
  }

  public async issue(
    input: Readonly<{
      actorUserId: string;
      telegramUserId: string;
      scope: AdminActionScope;
      ttlSeconds?: number;
    }>,
  ): Promise<string> {
    const ttlSeconds = input.ttlSeconds ?? 300;
    if (
      !UUID.test(input.actorUserId) ||
      !TELEGRAM_USER_ID.test(input.telegramUserId) ||
      !validScope(input.scope) ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 30 ||
      ttlSeconds > 900
    )
      throw invalidScope();
    const facts = this.authorizeFacts(
      await this.authorization.loadByTelegramIdentity({
        actorUserId: input.actorUserId,
        telegramUserId: input.telegramUserId,
      }),
      input.actorUserId,
      input.scope.requiredPermission,
    );
    const state: StoredAdminAction = {
      version: 1,
      purpose: 'admin_action',
      adminUserId: facts.adminUserId,
      actorUserId: facts.actorUserId,
      ...input.scope,
      expiresAt: this.now() + ttlSeconds * 1_000,
    };
    if (!validStoredState(state)) throw invalidScope();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = this.randomId();
      if (!TOKEN_ID.test(id)) throw new Error('Admin action-token identifier is invalid.');
      if (await this.tokens.putIfAbsent(id, JSON.stringify(state), ttlSeconds))
        return this.token(id);
    }
    throw new Error('Admin action-token allocation failed.');
  }

  public async authorize(
    input: Readonly<{
      actor: Actor;
      token: string;
      commandCode: string;
      requiredPermission: M7Permission;
      targetType: string;
    }>,
  ): Promise<AuthorizedAdminAction> {
    if (
      input.actor.kind !== 'admin' ||
      !UUID.test(input.actor.userId) ||
      !COMMAND_CODE.test(input.commandCode) ||
      !isPermission(input.requiredPermission) ||
      !TARGET_TYPE.test(input.targetType)
    )
      throw denied();
    const match = TOKEN.exec(input.token);
    if (match === null) throw denied();
    const expected = Buffer.from(this.signature(match[1]!), 'base64url');
    const supplied = Buffer.from(match[3]!, 'base64url');
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected))
      throw denied();
    const stored = await this.tokens.get(match[2]!);
    if (stored === undefined) throw denied();
    let state: unknown;
    try {
      state = JSON.parse(stored) as unknown;
    } catch {
      throw denied();
    }
    if (
      !validStoredState(state) ||
      state.expiresAt <= this.now() ||
      state.actorUserId !== input.actor.userId ||
      state.commandCode !== input.commandCode ||
      state.requiredPermission !== input.requiredPermission ||
      state.targetType !== input.targetType
    )
      throw denied();
    this.authorizeFacts(
      await this.authorization.loadCurrent({
        adminUserId: state.adminUserId,
        actorUserId: state.actorUserId,
      }),
      state.actorUserId,
      state.requiredPermission,
      state.adminUserId,
    );
    return {
      adminUserId: state.adminUserId,
      actorUserId: state.actorUserId,
      commandCode: state.commandCode,
      requiredPermission: state.requiredPermission,
      targetType: state.targetType,
      targetId: state.targetId,
      expectedTargetVersion: state.expectedTargetVersion,
    };
  }
}
