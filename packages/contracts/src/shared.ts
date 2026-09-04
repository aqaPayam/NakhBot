import { Type } from '@sinclair/typebox';

export const UuidSchema = Type.String({ format: 'uuid' });
export const UtcTimestampSchema = Type.String({ format: 'date-time' });

export const ActorSchema = Type.Object(
  {
    userId: UuidSchema,
    kind: Type.Union([Type.Literal('user'), Type.Literal('admin'), Type.Literal('system')]),
  },
  { additionalProperties: false },
);

export const ChannelContextSchema = Type.Object(
  {
    channel: Type.Union([
      Type.Literal('telegram'),
      Type.Literal('web'),
      Type.Literal('mobile'),
      Type.Literal('internal'),
    ]),
    channelIdentityId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
