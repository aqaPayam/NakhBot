import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema, UtcTimestampSchema } from './shared.js';

const user = Type.Object(
  { kind: Type.Literal('user'), userId: UuidSchema },
  { additionalProperties: false },
);
const admin = Type.Object(
  { kind: Type.Literal('admin'), userId: UuidSchema },
  { additionalProperties: false },
);
const invitationToken = Type.String({
  pattern: '^v1\\.mt\\.[A-Za-z0-9_-]{43}$',
  minLength: 49,
  maxLength: 49,
});
const code = Type.String({ pattern: '^[0-9]{6}$', minLength: 6, maxLength: 6 });
export const AdminTotpBeginSchema = Type.Object(
  { actor: user, requestId: UuidSchema, invitationToken },
  { additionalProperties: false },
);
export const AdminTotpConfirmSchema = Type.Object(
  { actor: user, requestId: UuidSchema, invitationToken, code },
  { additionalProperties: false },
);
export const AdminTotpSignInSchema = Type.Object(
  { actor: user, requestId: UuidSchema, code },
  { additionalProperties: false },
);
export const AdminSessionLogoutSchema = Type.Object(
  { actor: admin, requestId: UuidSchema },
  { additionalProperties: false },
);
export const AdminTotpBeginResultSchema = Type.Object(
  {
    enrollmentUri: Type.String({ minLength: 100, maxLength: 512, pattern: '^otpauth://totp/' }),
    expiresAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);
export const AdminTotpConfirmResultSchema = Type.Object(
  { status: Type.Literal('activated'), replayed: Type.Boolean() },
  { additionalProperties: false },
);
export const AdminSessionResultSchema = Type.Object(
  {
    adminSessionToken: Type.String({
      pattern: '^v1\\.as\\.[A-Za-z0-9_-]{43}$',
      minLength: 49,
      maxLength: 49,
    }),
    expiresAt: UtcTimestampSchema,
    mfaExpiresAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);
export const AdminSessionLogoutResultSchema = Type.Object(
  { status: Type.Literal('revoked') },
  { additionalProperties: false },
);
export type AdminTotpSignIn = Static<typeof AdminTotpSignInSchema>;
export type AdminSessionLogout = Static<typeof AdminSessionLogoutSchema>;
