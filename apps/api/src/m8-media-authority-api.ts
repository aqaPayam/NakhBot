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
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { HmacMediaDeliveryTokens, EdgeHmacMediaAudienceAuthenticator } from '@nakh/media-delivery';
import { PostgresMediaDeliveryAuthorization, type NakhDatabase } from '@nakh/persistence-postgres';

const AUTHORITY = Symbol('M8_MEDIA_SOURCE_AUTHORITY');
export class MediaSourceAuthorityVerifier {
  public constructor(
    private readonly origin: string,
    private readonly tokens: HmacMediaDeliveryTokens,
    private readonly audience: Pick<EdgeHmacMediaAudienceAuthenticator, 'authenticate'>,
    private readonly source: Pick<PostgresMediaDeliveryAuthorization, 'isCurrent'>,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}
  public async check(authorization: string | undefined, body: unknown): Promise<boolean> {
    try {
      if (
        authorization === undefined ||
        authorization.length > 520 ||
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !('path' in body) ||
        !('token' in body) ||
        typeof body.path !== 'string' ||
        typeof body.token !== 'string' ||
        body.path.length > 160 ||
        body.token.length > 2048
      )
        return false;
      const request = new Request(this.origin, { headers: { authorization } });
      const audienceId = await this.audience.authenticate(request);
      if (audienceId === null) return false;
      const claims = this.tokens.verify(body.token, {
        path: body.path,
        audienceId,
        now: this.now(),
      });
      if (!(await this.source.isCurrent(claims))) return false;
      // Audience and grant TTL can expire while native source authority is waiting.
      if ((await this.audience.authenticate(request)) !== audienceId) return false;
      this.tokens.verify(body.token, { path: body.path, audienceId, now: this.now() });
      return true;
    } catch {
      return false;
    }
  }
}

@Controller('internal/media')
class MediaAuthorityController {
  public constructor(@Inject(AUTHORITY) private readonly authority: MediaSourceAuthorityVerifier) {}
  @Post('source-authority')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  public async check(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<{ allowed: boolean }> {
    return { allowed: await this.authority.check(request.headers.authorization, body) };
  }
}

@Module({})
export class M8MediaAuthorityApiModule {
  public static register(authority: MediaSourceAuthorityVerifier): DynamicModule {
    return {
      module: M8MediaAuthorityApiModule,
      controllers: [MediaAuthorityController],
      providers: [{ provide: AUTHORITY, useValue: authority }],
    };
  }
}

function key(reference: string, resolve: (reference: string) => string): Uint8Array {
  const encoded = resolve(reference);
  const value = Buffer.from(encoded, 'base64url');
  if (
    !/^[A-Za-z0-9_-]+$/u.test(encoded) ||
    value.length < 32 ||
    value.length > 64 ||
    value.toString('base64url') !== encoded
  )
    throw new Error('media_authority_key_invalid');
  return value;
}

/** Actual API composition, under the existing explicit media-delivery activation flag. */
export function createMediaAuthorityApi(
  config: AppConfig,
  database: NakhDatabase,
  resolve: (reference: string) => string = resolveSecretReference,
): DynamicModule[] {
  if (!config.telegram.likedByDeliveryEnabled) return [];
  const origin = `https://${config.media.cdnHost}`;
  const signingKey = key(config.media.signingKeyRef, resolve);
  const audienceKey = key(config.media.audienceKeyRef, resolve);
  if (Buffer.from(signingKey).equals(Buffer.from(audienceKey)))
    throw new Error('media_authority_keys_must_differ');
  return [
    M8MediaAuthorityApiModule.register(
      new MediaSourceAuthorityVerifier(
        origin,
        new HmacMediaDeliveryTokens({
          currentKeyId: config.media.signingKeyId,
          keys: new Map([[config.media.signingKeyId, signingKey]]),
        }),
        new EdgeHmacMediaAudienceAuthenticator(
          origin,
          new Map([[config.media.audienceKeyId, audienceKey]]),
        ),
        new PostgresMediaDeliveryAuthorization(
          database,
          config.environment === 'local' ? 'development' : config.environment,
        ),
      ),
    ),
  ];
}
