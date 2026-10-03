import { createHash, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type {
  AdminCommandExecutionResult,
  AdminIngressRejection,
  RecordAdminIngressRejectionHandler,
} from '@nakh/application';
import { ApplicationError, type Actor, type IdGenerator, type M7Permission } from '@nakh/domain';
import type { M7ApiBoundary } from './m7-api-boundary.js';

interface Command {
  readonly actor: Actor;
  readonly commandType: string;
  readonly commandId: string;
  readonly requestId: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const transportFields = new Set([
  'requestId',
  'occurredAt',
  'locale',
  'idempotencyKey',
  'channelContext',
]);
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function canonical(value: unknown): string {
  const seen = new WeakSet<object>();
  const result = JSON.stringify(value, (_key, child: unknown): unknown => {
    if (child !== null && typeof child === 'object') {
      if (seen.has(child)) throw new Error('Unsupported request shape');
      seen.add(child);
      if (!Array.isArray(child)) {
        const row = child as Record<string, unknown>;
        return Object.fromEntries(
          Object.keys(row)
            .sort()
            .map((key) => [key, row[key]]),
        );
      }
    }
    return child;
  });
  if (result === undefined || Buffer.byteLength(result, 'utf8') > 256 * 1024)
    throw new Error('Unsupported request shape');
  return result;
}
function safe(error: unknown): ApplicationError {
  return error instanceof ApplicationError && error.status >= 400 && error.status < 500
    ? new ApplicationError(error.code, 'error.m7.unavailable', error.status)
    : new ApplicationError('internal_error', 'error.m7.internal', 500);
}
/** Internal transport coordinator. Early failures receive no business-target or plaintext capability. */
export class AuditedAdminMutationIngress {
  public constructor(
    private readonly boundary: M7ApiBoundary,
    private readonly journal: Pick<RecordAdminIngressRejectionHandler, 'record' | 'recover'>,
    private readonly ids: IdGenerator = { uuid: randomUUID },
  ) {}
  public async execute<C extends Command, T>(
    schema: object,
    request: Pick<FastifyRequest, 'headers'>,
    body: unknown,
    scope: Readonly<{ commandCode: string; requiredPermission: M7Permission }>,
    execute: (command: C, actor: Actor) => Promise<AdminCommandExecutionResult<T>>,
  ): Promise<AdminCommandExecutionResult<T>> {
    const actor = await this.boundary.actor(request, 'admin'),
      row = object(body);
    const commandId =
      typeof row?.commandId === 'string' && UUID.test(row.commandId)
        ? row.commandId
        : this.ids.uuid();
    const requestId =
      typeof row?.requestId === 'string' && UUID.test(row.requestId)
        ? row.requestId
        : this.ids.uuid();
    request.headers['x-request-id'] = requestId;
    const payload =
      row === undefined
        ? body
        : Object.fromEntries(Object.entries(row).filter(([key]) => !transportFields.has(key)));
    let serialized: string,
      invalidShape = false;
    try {
      serialized = canonical(payload);
    } catch {
      serialized = 'unsupported-request-shape';
      invalidShape = true;
    }
    const context: AdminIngressRejection = {
      actor,
      commandId,
      requestId,
      ...scope,
      requestDigest: createHash('sha256')
        .update(
          JSON.stringify([
            'admin-ingress',
            1,
            actor.userId,
            scope.commandCode,
            scope.requiredPermission,
            serialized,
          ]),
        )
        .digest('hex'),
    };
    try {
      const recovered = await this.journal.recover(context);
      if (recovered !== undefined) return recovered;
      if (invalidShape)
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      const command = this.boundary.parse<C>(schema, body, actor);
      if (command.commandType !== scope.commandCode)
        throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
      return await execute(command, actor);
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'idempotency_conflict')
        throw safe(error);
      try {
        return await this.journal.record({
          ...context,
          outcome:
            error instanceof ApplicationError && error.status >= 400 && error.status < 500
              ? 'rejected'
              : 'failed',
        });
      } catch (auditFailure) {
        // A required audit failure never becomes a successful or unaudited mutation receipt.
        throw safe(auditFailure);
      }
    }
  }
}
