import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  Module,
  Post,
  Req,
  type DynamicModule,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Ajv2020 as Ajv, type ValidateFunction } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import {
  isAccountControlLife,
  type AccountControlActor,
  type AccountControlSessionService,
  type AccountDeletionStore,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import {
  PrepareAccountDeletionQuerySchema,
  PreparedAccountDeletionSchema,
  RequestAccountDeletionCommandSchema,
  RequestAccountDeletionResultSchema,
  CancelAccountDeletionCommandSchema,
  CancelAccountDeletionResultSchema,
  GetAccountDeletionStatusQuerySchema,
  AccountDeletionStatusSchema,
  type PrepareAccountDeletionQuery,
  type PreparedAccountDeletion,
  type RequestAccountDeletionCommand,
  type RequestAccountDeletionResult,
  type CancelAccountDeletionCommand,
  type CancelAccountDeletionResult,
  type GetAccountDeletionStatusQuery,
  type AccountDeletionStatus,
} from '@nakh/contracts';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import {
  createPostgresAccountControls,
  PostgresAccountDeletionStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';

import { M8AccountReturnApiModule } from './m8-account-return-api.js';
import { PostgresAccountReturnStore } from '@nakh/persistence-postgres';

export interface M8AccountDeletionApiOptions {
  readonly controls: Pick<AccountControlSessionService, 'authenticate'>;
  readonly store: (actor: AccountControlActor) => AccountDeletionStore;
}
const OPTIONS = Symbol('M8_ACCOUNT_DELETION');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const addFormats = formatsModule.default as unknown as (
  ajv: InstanceType<typeof Ajv>,
) => InstanceType<typeof Ajv>;
class Boundary {
  private readonly ajv = new Ajv({ allErrors: false });
  private readonly validators = new WeakMap<object, ValidateFunction>();
  public constructor(private readonly options: M8AccountDeletionApiOptions) {
    addFormats(this.ajv);
  }
  private valid(schema: object, value: unknown): boolean {
    let validate = this.validators.get(schema);
    if (validate === undefined) {
      validate = this.ajv.compile(schema);
      this.validators.set(schema, validate);
    }
    return validate(value) === true;
  }
  public async execute<T extends { readonly actor: { kind: 'user'; userId: string } }, R>(
    request: FastifyRequest,
    body: unknown,
    inputSchema: object,
    outputSchema: object,
    action: (store: AccountDeletionStore, input: T) => Promise<R>,
  ): Promise<R> {
    try {
      const value = request.headers.authorization;
      const match =
        typeof value === 'string' && value.length <= 4103
          ? /^Bearer ([A-Za-z0-9._~-]{16,4096})$/u.exec(value)
          : null;
      if (match === null)
        throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      const issued = await this.options.controls.authenticate({
        bearerToken: match[1]!,
        audience: 'account_control',
      });
      if (
        !isAccountControlLife(issued) ||
        issued?.kind !== 'user' ||
        issued.scope !== 'account_control' ||
        !UUID.test(issued.controlGrantId)
      )
        throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      const actor: AccountControlActor = Object.freeze({
        kind: 'user',
        scope: 'account_control',
        userId: issued.userId,
        productEpoch: issued.productEpoch,
        controlGrantId: issued.controlGrantId,
      });
      if (
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body) ||
        'actor' in body ||
        'channelContext' in body
      )
        throw new ApplicationError('invalid_request', 'error.deletion.confirmation_invalid', 400);
      const input = { ...body, actor: { kind: 'user', userId: actor.userId } };
      if (!this.valid(inputSchema, input))
        throw new ApplicationError('invalid_request', 'error.deletion.confirmation_invalid', 400);
      const result = await action(this.options.store(actor), input as T);
      const current = await this.options.controls.authenticate({
        bearerToken: match[1]!,
        audience: 'account_control',
      });
      if (
        current?.kind !== 'user' ||
        current.scope !== 'account_control' ||
        current.userId !== actor.userId ||
        current.productEpoch !== actor.productEpoch ||
        current.controlGrantId !== actor.controlGrantId
      )
        throw new ApplicationError('unauthorized', 'error.deletion.unavailable', 401);
      if (!this.valid(outputSchema, result)) throw new Error('Invalid deletion result');
      return result;
    } catch (error) {
      if (error instanceof ApplicationError && error.status >= 400 && error.status < 500)
        throw new ApplicationError(error.code, 'error.deletion.unavailable', error.status);
      throw new ApplicationError('internal_error', 'error.deletion.unavailable', 500);
    }
  }
}
@Controller('v1/account/deletion')
class AccountDeletionController {
  private readonly boundary: Boundary;
  public constructor(@Inject(OPTIONS) options: M8AccountDeletionApiOptions) {
    this.boundary = new Boundary(options);
  }
  @Post('prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public prepare(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<PreparedAccountDeletion> {
    return this.boundary.execute<PrepareAccountDeletionQuery, PreparedAccountDeletion>(
      request,
      body,
      PrepareAccountDeletionQuerySchema,
      PreparedAccountDeletionSchema,
      (store, input) => store.prepare(input),
    );
  }
  @Post('confirm')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public confirm(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<RequestAccountDeletionResult> {
    return this.boundary.execute<RequestAccountDeletionCommand, RequestAccountDeletionResult>(
      request,
      body,
      RequestAccountDeletionCommandSchema,
      RequestAccountDeletionResultSchema,
      (store, input) => store.request(input),
    );
  }
  @Post('cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public cancel(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<CancelAccountDeletionResult> {
    return this.boundary.execute<CancelAccountDeletionCommand, CancelAccountDeletionResult>(
      request,
      body,
      CancelAccountDeletionCommandSchema,
      CancelAccountDeletionResultSchema,
      (store, input) => store.cancel(input),
    );
  }
  @Post('status')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public status(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<AccountDeletionStatus> {
    return this.boundary.execute<GetAccountDeletionStatusQuery, AccountDeletionStatus>(
      request,
      body,
      GetAccountDeletionStatusQuerySchema,
      AccountDeletionStatusSchema,
      async (store, input) => {
        const status = await store.status(input);
        if (status === undefined)
          throw new ApplicationError('not_found', 'error.deletion.unavailable', 404);
        return status;
      },
    );
  }
}
@Module({})
export class M8AccountDeletionApiModule {
  public static register(options: M8AccountDeletionApiOptions): DynamicModule {
    return {
      module: M8AccountDeletionApiModule,
      controllers: [AccountDeletionController],
      providers: [{ provide: OPTIONS, useValue: options }],
    };
  }
}
function key(reference: string): Uint8Array {
  const value = resolveSecretReference(reference);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error('Account control key unavailable.');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value)
    throw new Error('Account control key unavailable.');
  return decoded;
}
/** Issuance is deliberately absent from HTTP. Trusted primary ingress owns it. */
export function createAccountDeletionApi(
  config: AppConfig,
  database: NakhDatabase,
): DynamicModule[] {
  if (!config.deletion.apiEnabled) return [];
  const controls = createPostgresAccountControls(database, key(config.deletion.controlKeyRef));
  const secrets = {
    activeKeyId: config.deletion.confirmationKeyId,
    keys: new Map([[config.deletion.confirmationKeyId, key(config.deletion.confirmationKeyRef)]]),
  };
  return [
    M8AccountDeletionApiModule.register({
      controls,
      store: (actor) => new PostgresAccountDeletionStore(database, secrets, actor),
    }),
    ...(config.deletion.returnApiEnabled
      ? [
          M8AccountReturnApiModule.register({
            controls,
            store: (actor) => new PostgresAccountReturnStore(database, actor),
          }),
        ]
      : []),
  ];
}
