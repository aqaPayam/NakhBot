import type { UserSessionActor } from '../security/user-session.js';

/** Native offer facts only. Purchase text and navigation are not payment authority. */
export type StarsPurchaseOffer = Readonly<{
  fundingIntentId: string;
  version: number;
  digest: string;
  reason: 'buy_credit_package' | 'send_nakh';
  stars: string;
  packageCode: string | null;
  credits: string | null;
  expiresAt: Date;
}>;
export type StarsPurchaseConsentWrite = Readonly<{
  fundingIntentId: string;
  expectedVersion: number;
  offerDigest: string;
  termsVersion: string;
  documentDigest: string;
  locale: string;
  commandId: string;
  requestId: string;
}>;
export type StarsPurchaseConsent = Readonly<{
  id: string;
  termsVersion: string;
  documentDigest: string;
  locale: string;
  offer: StarsPurchaseOffer;
  replayed: boolean;
}>;
export interface StarsPurchaseConsentStore {
  readonly owner: UserSessionActor;
  review(fundingIntentId: string, expectedVersion: number): Promise<StarsPurchaseOffer>;
  accept(write: StarsPurchaseConsentWrite): Promise<StarsPurchaseConsent>;
  require(
    consentId: string,
    fundingIntentId: string,
    expectedVersion: number,
  ): Promise<StarsPurchaseConsent>;
}
