import { Ajv2020 as Ajv, type ValidateFunction } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import { ApplicationError, type Actor } from '@nakh/domain';
import { isUserProductLife, type UserSessionActor } from '@nakh/application';

/** Server-injected verifier: user results must carry ORIGINAL issued productEpoch
 * and sessionGrantId; sampling the current Account to enrich an old bearer is forbidden. */
export interface M7ApiAuthenticator {
  authenticate(
    input: Readonly<{ bearerToken: string; audience: 'user' | 'admin' }>,
  ): Promise<Actor | undefined>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const addFormats = formatsModule.default as unknown as (
  ajv: InstanceType<typeof Ajv>,
) => InstanceType<typeof Ajv>;

/** Transport validation never substitutes for the application's current authorization. */
export class M7ApiBoundary {
  private readonly ajv = new Ajv({ allErrors: false });
  private readonly validators = new WeakMap<object, ValidateFunction>();
  private readonly users = new WeakMap<object, string>();
  public constructor(private readonly authenticator: M7ApiAuthenticator) {
    addFormats(this.ajv);
  }
  public async actor(
    request: Readonly<{ headers: Readonly<{ authorization?: unknown }> }>,
    audience: 'user' | 'admin',
  ): Promise<Actor> {
    const header = request.headers.authorization;
    const match =
      typeof header === 'string' && header.length <= 4103
        ? /^Bearer ([A-Za-z0-9._~-]{16,4096})$/u.exec(header)
        : null;
    if (match === null) throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
    const actor = await this.safe(() =>
      this.authenticator.authenticate({ bearerToken: match[1]!, audience }),
    );
    if (actor === undefined || actor.kind !== audience || !UUID.test(actor.userId))
      throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
    if (audience === 'user') {
      const scoped = actor as Partial<UserSessionActor>;
      const sessionGrantId = scoped.sessionGrantId;
      if (
        !isUserProductLife(scoped) ||
        typeof sessionGrantId !== 'string' ||
        !UUID.test(sessionGrantId)
      )
        throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
      const user: UserSessionActor = Object.freeze({
        kind: 'user',
        userId: scoped.userId,
        productEpoch: scoped.productEpoch,
        sessionGrantId,
      });
      this.users.set(user, match[1]!);
      return user;
    }
    return { kind: actor.kind, userId: actor.userId };
  }
  public async user(
    request: Readonly<{ headers: Readonly<{ authorization?: unknown }> }>,
  ): Promise<UserSessionActor> {
    return (await this.actor(request, 'user')) as UserSessionActor;
  }
  public async userResult<T>(
    schema: object,
    user: UserSessionActor,
    execute: () => Promise<T>,
  ): Promise<T> {
    const bearerToken = this.users.get(user);
    if (bearerToken === undefined)
      throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
    return this.result(schema, async () => {
      const result = await execute();
      const current = (await this.authenticator.authenticate({ bearerToken, audience: 'user' })) as
        Partial<UserSessionActor> | undefined;
      if (
        current?.kind !== 'user' ||
        current.userId !== user.userId ||
        current.productEpoch !== user.productEpoch ||
        current.sessionGrantId !== user.sessionGrantId
      )
        throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
      return result;
    });
  }
  public parse<T extends { readonly actor: Actor }>(
    schema: object,
    value: unknown,
    actor: Actor,
  ): T {
    if (!this.valid(schema, value))
      throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
    const parsed = value as T;
    if (parsed.actor.kind !== actor.kind || parsed.actor.userId !== actor.userId)
      throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
    return parsed;
  }
  public async result<T>(schema: object, execute: () => Promise<T>): Promise<T> {
    return this.safe(async () => {
      const result = await execute();
      if (!this.valid(schema, result)) throw new Error('Invalid M7 response');
      return result;
    });
  }
  private valid(schema: object, value: unknown): boolean {
    let validate = this.validators.get(schema);
    if (validate === undefined) {
      validate = this.ajv.compile(schema);
      this.validators.set(schema, validate);
    }
    return validate(value) === true;
  }
  private async safe<T>(execute: () => Promise<T>): Promise<T> {
    try {
      return await execute();
    } catch (error) {
      if (error instanceof ApplicationError && error.status >= 400 && error.status < 500)
        throw new ApplicationError(error.code, 'error.m7.unavailable', error.status);
      // Discard source error, cause and details before the global filter or logger can observe them.
      throw new ApplicationError('internal_error', 'error.m7.internal', 500);
    }
  }
}
