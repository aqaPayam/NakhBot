import { sql } from 'kysely';
import type { UserSessionActor } from '@nakh/application';
import type { PendingNakhStatus, PendingNakhCancelResolution } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { PostgresUserSessionStore } from './user-session-store.js';
export type CustomerPendingNakh = Readonly<{
  pendingNakhId: string;
  targetName: string;
  text: string;
  status: PendingNakhStatus;
  version: number;
  createdAt: Date;
  expiresAt: Date;
  cancelResolution: PendingNakhCancelResolution | null;
}>;
export type PendingNakhPosition = Readonly<{ createdAt: Date; pendingNakhId: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function denied(): never {
  throw new ApplicationError('nakh_unavailable', 'error.nakh.unavailable', 403);
}
/** Sender-only ordinary drafts/history. No receiver or provider identifier is
 * returned, and every read retains the original native session and flow lives. */
export class PostgresNakhCustomerReadStore {
  private readonly owner: UserSessionActor;
  public constructor(
    private readonly database: NakhDatabase,
    owner: UserSessionActor,
  ) {
    this.owner = Object.freeze({ ...owner });
  }
  private async read(
    tx: NakhDatabase,
    limit: number,
    id?: string,
    history?: boolean,
    after?: PendingNakhPosition,
  ): Promise<CustomerPendingNakh[]> {
    if (
      this.owner.kind !== 'user' ||
      !(await new PostgresUserSessionStore(tx).current(this.owner, this.owner.sessionGrantId))
    )
      denied();
    return (
      await sql<CustomerPendingNakh>`SELECT pending.id AS "pendingNakhId",target.name AS "targetName",pending.text,
   CASE WHEN pending.status='pending_payment' AND pending.expires_at<=clock_timestamp() THEN 'expired' ELSE pending.status END AS status,
   pending.version,pending.created_at AS "createdAt",pending.expires_at AS "expiresAt",pending.cancel_resolution AS "cancelResolution"
   FROM nakh.pending_nakhes pending JOIN nakh.current_flow_lives flow ON flow.id=pending.nakh_flow_id
    AND flow.sender_user_id=pending.sender_user_id
   JOIN identity.accounts actor ON actor.user_id=pending.sender_user_id
   JOIN identity.accounts peer ON peer.user_id=flow.receiver_user_id
   JOIN profile.profiles target ON target.user_id=peer.user_id
   WHERE pending.sender_user_id=${this.owner.userId}::uuid AND actor.product_epoch=${this.owner.productEpoch}
    AND actor.state='active' AND peer.state<>'deleted'
    ${id === undefined ? sql`` : sql`AND pending.id=${id}::uuid`}
    ${
      history === undefined
        ? sql``
        : history
          ? sql`AND (pending.status NOT IN('pending_payment','paid_and_sent')
      OR (pending.status='pending_payment' AND pending.expires_at<=clock_timestamp()))`
          : sql`AND pending.status='pending_payment' AND pending.expires_at>clock_timestamp()`
    }
    ${after === undefined ? sql`` : sql`AND (pending.created_at<${after.createdAt} OR (pending.created_at=${after.createdAt} AND pending.id<${after.pendingNakhId}::uuid))`}
   ORDER BY pending.created_at DESC,pending.id DESC LIMIT ${limit}`.execute(tx)
    ).rows;
  }
  public async page(
    input: Readonly<{ limit: number; history: boolean; after?: PendingNakhPosition }>,
  ): Promise<{ rows: readonly CustomerPendingNakh[]; hasMore: boolean }> {
    const query = structuredClone(input);
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 20 ||
      typeof query.history !== 'boolean' ||
      (query.after !== undefined &&
        (!(query.after.createdAt instanceof Date) ||
          !UUID.test(query.after.pendingNakhId) ||
          !Number.isFinite(query.after.createdAt.getTime())))
    )
      denied();
    return this.database
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (tx) => {
        const rows = await this.read(tx, query.limit + 1, undefined, query.history, query.after);
        return { rows: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
      });
  }
  public async detail(id: string): Promise<CustomerPendingNakh> {
    if (!UUID.test(id)) denied();
    return this.database
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (tx) => {
        const row = (await this.read(tx, 1, id))[0];
        if (!row) denied();
        return row;
      });
  }
}
