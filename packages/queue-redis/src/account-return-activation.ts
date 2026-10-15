import { createHash } from 'node:crypto';
import {
  isUserProductLife,
  type AccountReturnActivation,
  type AccountReturnActivationAuthority,
  type UserProductLife,
} from '@nakh/application';

export interface AccountReturnRedisScripts {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Native Return authorizes exactly one monotonic namespace transition. This
 * adapter copies no old body and never grants product authority on its own. */
export class RedisAccountReturnActivation implements AccountReturnActivation {
  public readonly namespaceHash: string;
  public constructor(
    private readonly redis: AccountReturnRedisScripts,
    private readonly prefix: string,
    private readonly authority: AccountReturnActivationAuthority,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(prefix))
      throw new Error('Opaque state activation is unavailable.');
    this.namespaceHash = createHash('sha256').update(`m8-ephemeral-v1\0${prefix}`).digest('hex');
  }
  private async evaluate(
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Shared BullMQ clients intentionally retry forever. This owning native
      // transaction must not hold Account locks indefinitely. A late execution
      // still faces the atomic predecessor CAS; a later tombstone always wins.
      return await Promise.race([
        this.redis.eval(script, keys.length, ...keys, ...args),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error()), 5000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  public async activate(life: UserProductLife): Promise<void> {
    try {
      if (!isUserProductLife(life) || life.productEpoch < 1) throw new Error();
      const captured = Object.freeze({ userId: life.userId, productEpoch: life.productEpoch });
      await this.authority.withCurrentReturn(captured, this.namespaceHash, async (proof) => {
        if (
          proof.userId !== captured.userId ||
          proof.productEpoch !== captured.productEpoch ||
          proof.previousProductEpoch !== captured.productEpoch - 1 ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            proof.returnAuditId,
          )
        )
          throw new Error();
        const scope = `${this.prefix}:owned-action:{${createHash('sha256').update(captured.userId.toLowerCase()).digest('hex')}}`;
        const result = await this.evaluate(
          `
          local state=redis.call('GET',KEYS[1])
          if redis.call('PTTL',KEYS[1]) ~= -1 then return -1 end
          local active='active:' .. ARGV[2]
          if state==active then return 0 end
          if state~='blocked:' .. ARGV[1] then return -1 end
          if redis.call('HLEN',KEYS[2])~=0 or redis.call('EXISTS',KEYS[3])~=0 then return -1 end
          redis.call('SET',KEYS[1],active)
          return 1
        `,
          [
            `${scope}:life`,
            `${scope}:${proof.previousProductEpoch}:index`,
            `${scope}:${captured.productEpoch}:index`,
          ],
          [String(proof.previousProductEpoch), String(captured.productEpoch)],
        );
        if (result !== 0 && result !== 1) throw new Error();
      });
    } catch {
      throw new Error('Opaque state activation is unavailable.');
    }
  }
}
