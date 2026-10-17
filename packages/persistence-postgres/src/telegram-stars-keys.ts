import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  AesGcmInvoicePayloadProtector,
  type InvoicePayloadProtector,
  type EncryptedProviderEvidence,
} from '@nakh/application';
import type { NakhDatabase } from './database.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const AAD = Buffer.from('nakh-telegram-stars-provider-evidence-v1');
function unavailable(): never {
  throw new Error('Stars keys unavailable.');
}
function key(value: unknown): Buffer {
  if (typeof value !== 'string') return unavailable();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) return unavailable();
  return bytes;
}
/** Financial keys outlive navigation. Historical encryption keys remain usable;
 * startup verifies custody and the stable lookup digest against native records. */
export class TelegramStarsKeys implements InvoicePayloadProtector {
  private readonly invoices = new Map<string, AesGcmInvoicePayloadProtector>();
  private readonly evidenceKeys = new Map<string, Buffer>();
  private readonly digestKey: Buffer;
  private readonly activeKeyId: string;
  private readonly fingerprints = new Set<string>();
  public constructor(encoded: string) {
    try {
      if (Buffer.byteLength(encoded) > 16384) unavailable();
      const json = record(JSON.parse(encoded));
      if (
        json === undefined ||
        Object.keys(json).sort().join(',') !== 'activeKeyId,digestKey,keys' ||
        typeof json.activeKeyId !== 'string' ||
        !Array.isArray(json.keys) ||
        json.keys.length < 1 ||
        json.keys.length > 64
      )
        unavailable();
      this.activeKeyId = json.activeKeyId;
      this.digestKey = key(json.digestKey);
      this.remember(this.digestKey);
      for (const input of json.keys) {
        const row = record(input);
        if (
          row === undefined ||
          Object.keys(row).sort().join(',') !== 'evidenceKey,id,invoiceKey' ||
          typeof row.id !== 'string' ||
          !/^[A-Za-z0-9_-]{1,32}$/u.test(row.id) ||
          this.invoices.has(row.id)
        )
          unavailable();
        const invoice = key(row.invoiceKey),
          evidence = key(row.evidenceKey);
        this.remember(invoice);
        this.remember(evidence);
        this.invoices.set(
          row.id,
          new AesGcmInvoicePayloadProtector(row.id, invoice, this.digestKey),
        );
        this.evidenceKeys.set(row.id, evidence);
      }
      if (!this.invoices.has(this.activeKeyId)) unavailable();
    } catch {
      unavailable();
    }
  }
  private remember(bytes: Buffer): void {
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (this.fingerprints.has(hash)) unavailable();
    this.fingerprints.add(hash);
  }
  public assertSeparateNavigationKey(bytes: Uint8Array): void {
    if (this.fingerprints.has(createHash('sha256').update(bytes).digest('hex'))) unavailable();
  }
  public issue(): ReturnType<InvoicePayloadProtector['issue']> {
    return this.invoices.get(this.activeKeyId)!.issue();
  }
  public digest(cleartext: string): string {
    return this.invoices.get(this.activeKeyId)!.digest(cleartext);
  }
  public reveal(ciphertext: Uint8Array, keyId: string): string {
    const cipher = this.invoices.get(keyId);
    if (cipher === undefined) unavailable();
    return cipher.reveal(ciphertext, keyId);
  }
  public protectEvidence(facts: Readonly<Record<string, string>>): EncryptedProviderEvidence {
    const plain = Buffer.from(
      JSON.stringify(
        Object.fromEntries(
          Object.keys(facts)
            .sort()
            .map((k) => [k, facts[k]]),
        ),
      ),
    );
    if (plain.length < 1 || plain.length > 8192) unavailable();
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.evidenceKeys.get(this.activeKeyId)!, nonce);
    cipher.setAAD(AAD);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return {
      digest: createHmac('sha256', this.digestKey).update(AAD).update(plain).digest('hex'),
      ciphertext: Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]),
      keyId: this.activeKeyId,
      schemaVersion: 1,
    };
  }
  public openEvidence(ciphertext: Uint8Array, keyId: string): Readonly<Record<string, unknown>> {
    try {
      const bytes = Buffer.from(ciphertext),
        secret = this.evidenceKeys.get(keyId);
      if (secret === undefined || bytes.length < 30 || bytes.length > 8221 || bytes[0] !== 1)
        unavailable();
      const cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(1, 13));
      cipher.setAAD(AAD);
      cipher.setAuthTag(bytes.subarray(13, 29));
      const value = record(
        JSON.parse(
          Buffer.concat([cipher.update(bytes.subarray(29)), cipher.final()]).toString('utf8'),
        ),
      );
      if (value === undefined) unavailable();
      return value;
    } catch {
      unavailable();
    }
  }
  public verifyEvidence(
    ciphertext: Uint8Array,
    keyId: string,
    digest: string,
  ): Readonly<Record<string, string>> {
    const opened = this.openEvidence(ciphertext, keyId),
      facts: Record<string, string> = {};
    for (const name of Object.keys(opened).sort()) {
      const value = opened[name];
      if (typeof value !== 'string') unavailable();
      facts[name] = value;
    }
    if (!/^[a-f0-9]{64}$/u.test(digest)) unavailable();
    const actual = createHmac('sha256', this.digestKey)
      .update(AAD)
      .update(Buffer.from(JSON.stringify(facts)))
      .digest();
    const expected = Buffer.from(digest, 'hex');
    if (!timingSafeEqual(actual, expected)) unavailable();
    return Object.freeze(facts);
  }
  public async verifyCustody(database: NakhDatabase): Promise<void> {
    const ids = await database
      .selectFrom('billing.payment_records')
      .select('invoice_payload_key_id')
      .distinct()
      .execute();
    for (const { invoice_payload_key_id: id } of ids) {
      if (!this.invoices.has(id)) unavailable();
      const row = await database
        .selectFrom('billing.payment_records')
        .select(['invoice_payload_ciphertext', 'invoice_payload_digest'])
        .where('invoice_payload_key_id', '=', id)
        .orderBy('id')
        .limit(1)
        .executeTakeFirstOrThrow();
      const expected = Buffer.from(row.invoice_payload_digest, 'hex'),
        actual = Buffer.from(this.digest(this.reveal(row.invoice_payload_ciphertext, id)), 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) unavailable();
    }
    // Evidence keys are retained as long as their financial facts exist.
    for (const table of [
      'billing.payment_provider_events',
      'billing.payment_provider_conflicts',
    ] as const) {
      const events = await database
        .selectFrom(table)
        .select('raw_payload_key_id')
        .distinct()
        .execute();
      for (const { raw_payload_key_id: id } of events) {
        if (!this.evidenceKeys.has(id)) unavailable();
        const row = await database
          .selectFrom(table)
          .select(['raw_payload_ciphertext', 'raw_payload_digest'])
          .where('raw_payload_key_id', '=', id)
          .orderBy('id')
          .limit(1)
          .executeTakeFirstOrThrow();
        this.verifyEvidence(row.raw_payload_ciphertext, id, row.raw_payload_digest);
      }
    }
  }
}
