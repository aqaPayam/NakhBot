import { captureVpsOperatorBinding } from './vps-trusted-operators.js';
import {
  VPS_READINESS_BINDING_FIELDS,
  withVpsOwnerDatabase,
  type VpsMachineIdentity,
} from './vps-launch-readiness.js';
import {
  captureFreeTestCreditModeCommand,
  freeTestCreditModeDigest,
  PostgresFreeTestCreditModeControl,
} from './free-test-credit-mode.js';
import type { DatabaseConfig, NakhDatabase } from './database.js';

/** Existing protected staging host, exact command approval for opening, independent closing. */
export async function runVpsFreeTestCreditControl(
  binding: unknown,
  command: unknown,
  readSecret: (path: string) => Promise<unknown>,
  observe?: () => Promise<VpsMachineIdentity>,
  connect?: (config: DatabaseConfig) => NakhDatabase,
): Promise<unknown> {
  try {
    const c = captureVpsOperatorBinding(binding),
      input = captureFreeTestCreditModeCommand(command);
    if (
      input.sourceSha !== c.sourceSha ||
      input.environment !== c.environment ||
      input.telegramBotId !== c.telegramBotId ||
      (input.enabled && c.approvedCommandDigest !== freeTestCreditModeDigest(input))
    )
      throw new Error();
    const base = Object.fromEntries(VPS_READINESS_BINDING_FIELDS.map((k) => [k, c[k]]));
    return await withVpsOwnerDatabase(
      base,
      readSecret,
      async (database, authenticate) => {
        await authenticate();
        const result = await new PostgresFreeTestCreditModeControl(database, c.operatorId).apply(
          input,
        );
        await authenticate();
        return { format: 1, kind: 'free-test-credit-mode', productionQualified: false, ...result };
      },
      observe,
      connect,
    );
  } catch {
    throw new Error('Free test credit control unavailable.');
  }
}
