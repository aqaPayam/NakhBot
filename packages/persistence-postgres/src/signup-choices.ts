import type { UserSessionActor, IdentityContextSnapshot } from '@nakh/application';
import { entryRouteFor, ApplicationError } from '@nakh/domain';
import { PostgresIdentityStore } from './identity-store.js';
import type { NakhDatabase } from './database.js';
import { requireCurrentUserSession } from './user-session-store.js';

/** Read-only presentation inputs. They never authorize a selection; signup
 * normalization and media eligibility recheck it in the mutation transaction. */
export class PostgresSignupChoices {
  private readonly actor: UserSessionActor;
  public constructor(
    private readonly database: NakhDatabase,
    actor: UserSessionActor,
  ) {
    this.actor = Object.freeze({ ...actor });
  }
  public context(): Promise<IdentityContextSnapshot & { profileVersion?: number }> {
    return this.database.transaction().execute(async (tx) => {
      await requireCurrentUserSession(tx, this.actor.userId, this.actor);
      const identity = await new PostgresIdentityStore(tx).getByUserId(this.actor.userId);
      if (identity === undefined)
        throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
      const profile =
        identity.accountState === 'active' || identity.accountState === 'restricted'
          ? await tx
              .selectFrom('profile.profiles')
              .select(['completion_status', 'version'])
              .where('user_id', '=', this.actor.userId)
              .executeTakeFirst()
          : undefined;
      const facts = {
        accountState: identity.accountState,
        visibilityEnabled: identity.visibilityEnabled,
        profileCompletion: profile?.completion_status ?? null,
      };
      return {
        ...identity,
        profileCompletion: facts.profileCompletion,
        entryRoute: entryRouteFor(facts),
        ...(profile === undefined ? {} : { profileVersion: profile.version }),
      };
    });
  }
  public async list(): Promise<{
    catalogs: Record<string, Array<{ code: string; labelKey: string; parent?: string }>>;
    photos: string[];
  }> {
    return this.database.transaction().execute(async (tx) => {
      await requireCurrentUserSession(tx, this.actor.userId, this.actor);
      const catalogs: Record<
        string,
        Array<{ code: string; labelKey: string; parent?: string }>
      > = {};
      for (const [kind, table] of [
        ['gender', 'catalog.gender_options'],
        ['relationship_gender_preference', 'catalog.gender_preferences'],
        ['relationship_goal', 'catalog.relationship_goals'],
        ['interests', 'catalog.interests'],
        ['languageCodes', 'catalog.languages'],
        ['personalityTagCodes', 'catalog.personality_tags'],
        ['country', 'catalog.countries'],
      ] as const) {
        const rows = await tx
          .selectFrom(table)
          .select(['code', 'label_key'])
          .where('is_active', '=', true)
          .orderBy('display_order')
          .orderBy('code')
          .execute();
        catalogs[kind] = rows.map((r) => ({ code: r.code, labelKey: r.label_key }));
      }
      const provinces = await tx
        .selectFrom('catalog.provinces as p')
        .innerJoin('catalog.countries as c', 'c.id', 'p.country_id')
        .select(['p.code', 'p.label_key', 'c.code as parent'])
        .where('p.is_active', '=', true)
        .where('c.is_active', '=', true)
        .orderBy('p.display_order')
        .orderBy('p.code')
        .execute();
      catalogs.province = provinces.map((r) => ({
        code: r.code,
        labelKey: r.label_key,
        parent: r.parent,
      }));
      const cities = await tx
        .selectFrom('catalog.cities as x')
        .innerJoin('catalog.provinces as p', 'p.id', 'x.province_id')
        .innerJoin('catalog.countries as c', 'c.id', 'p.country_id')
        .select(['x.code', 'x.label_key', 'p.code as parent', 'c.code as country'])
        .where('x.is_active', '=', true)
        .where('p.is_active', '=', true)
        .where('c.is_active', '=', true)
        .orderBy('x.display_order')
        .orderBy('x.code')
        .execute();
      catalogs.city = cities.map((r) => ({
        code: r.code,
        labelKey: r.label_key,
        parent: `${r.country}/${r.parent}`,
      }));
      const options = await tx
        .selectFrom('catalog.profile_option_values')
        .select(['category', 'code', 'label_key'])
        .where('is_active', '=', true)
        .orderBy('display_order')
        .orderBy('code')
        .execute();
      for (const r of options)
        (catalogs[r.category] ??= []).push({ code: r.code, labelKey: r.label_key });
      const photos = await tx
        .selectFrom('media.media_assets as a')
        .innerJoin('media.photo_variants as v', 'v.asset_id', 'a.id')
        .select('a.id')
        .where('a.owner_user_id', '=', this.actor.userId)
        .where('a.validation_state', '=', 'valid')
        .where('a.deleted_at', 'is', null)
        .where('a.storage_deleted_at', 'is', null)
        .where('v.variant_type', '=', 'thumbnail')
        .where('v.transformation_version', '=', 1)
        .where('v.deleted_at', 'is', null)
        .where('v.storage_deleted_at', 'is', null)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('media.profile_photos as p')
                .select('p.id')
                .whereRef('p.asset_id', '=', 'a.id'),
            ),
          ),
        )
        .orderBy('a.created_at')
        .orderBy('a.id')
        .limit(6)
        .execute();
      return { catalogs, photos: photos.map((r) => r.id) };
    });
  }
}
