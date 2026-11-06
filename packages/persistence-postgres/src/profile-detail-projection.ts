import { sql } from 'kysely';
import { ApplicationError } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import type { CandidateProfileDetail } from './candidate-presentation-store.js';
function denied(): never {
  throw new ApplicationError('discovery_unavailable', 'error.discovery.unavailable', 403);
}
/** Private fields are loaded only after the caller revalidates its exact source. */
export async function readProfileDetailProjection(
  tx: NakhDatabase,
  viewerUserId: string,
  targetUserId: string,
  photos: CandidateProfileDetail['photos'],
): Promise<CandidateProfileDetail> {
  const profile = await tx
    .selectFrom('profile.profiles as p')
    .innerJoin('catalog.cities as city', 'city.id', 'p.city_id')
    .innerJoin('catalog.provinces as province', 'province.id', 'p.province_id')
    .innerJoin('catalog.countries as country', 'country.id', 'p.country_id')
    .innerJoin('catalog.gender_options as gender', 'gender.id', 'p.gender_option_id')
    .innerJoin(
      'catalog.gender_preferences as preference',
      'preference.id',
      'p.gender_preference_id',
    )
    .innerJoin('catalog.relationship_goals as goal', 'goal.id', 'p.relationship_goal_id')
    .innerJoin('identity.telegram_identities as telegram', (join) =>
      join.on('telegram.user_id', '=', viewerUserId),
    )
    .select([
      'p.id',
      'p.name',
      'p.highlight',
      'p.bio',
      'p.version as profileVersion',
      'city.label_key as city',
      'province.label_key as province',
      'country.label_key as country',
      'gender.label_key as genderLabelKey',
      'preference.label_key as preferenceLabelKey',
      'goal.label_key as goalLabelKey',
      'telegram.telegram_user_id as telegramUserId',
      sql<number>`EXTRACT(YEAR FROM timezone('UTC',clock_timestamp()))::integer-p.birth_year`.as(
        'age',
      ),
    ])
    .where('p.user_id', '=', targetUserId)
    .executeTakeFirst();
  if (!profile) denied();
  const interests = await tx
    .selectFrom('profile.profile_interests as s')
    .innerJoin('catalog.interests as c', 'c.id', 's.interest_id')
    .select('c.label_key')
    .where('s.profile_id', '=', profile.id)
    .where('c.is_active', '=', true)
    .orderBy('c.display_order')
    .orderBy('c.code')
    .execute();
  const optional: Array<CandidateProfileDetail['optional'][number]> = [];
  const details = await tx
    .selectFrom('profile.profile_optional_details')
    .selectAll()
    .where('profile_id', '=', profile.id)
    .executeTakeFirst();
  if (details) {
    if (details.height_cm !== null)
      optional.push({ labelKey: 'signup.ui.height_cm', value: details.height_cm });
    if (details.job_title !== null)
      optional.push({ labelKey: 'signup.ui.job', value: details.job_title });
    const options = await tx
      .selectFrom('catalog.profile_option_values')
      .select(['category', 'code', 'label_key'])
      .where('is_active', '=', true)
      .execute();
    for (const [field, category, label] of [
      ['education_level_code', 'education', 'education_level_code'],
      ['smoking_preference_code', 'smoking', 'smoking_preference_code'],
      ['pets_preference_code', 'pets', 'pets_preference_code'],
      ['exercise_frequency_code', 'exercise', 'exercise_frequency_code'],
      ['religion_importance_code', 'religion_importance', 'religion_code'],
      ['children_preference_code', 'children_preference', 'children_preference_code'],
    ] as const) {
      const option = options.find((o) => o.category === category && o.code === details[field]);
      if (option) optional.push({ labelKey: 'signup.ui.' + label, value: [option.label_key] });
    }
  }
  const languages = await tx
    .selectFrom('profile.profile_languages as s')
    .innerJoin('catalog.languages as c', 'c.id', 's.language_id')
    .select('c.label_key')
    .where('s.profile_id', '=', profile.id)
    .where('c.is_active', '=', true)
    .orderBy('c.display_order')
    .orderBy('c.code')
    .execute();
  const tags = await tx
    .selectFrom('profile.profile_personality_tags as s')
    .innerJoin('catalog.personality_tags as c', 'c.id', 's.personality_tag_id')
    .select('c.label_key')
    .where('s.profile_id', '=', profile.id)
    .where('c.is_active', '=', true)
    .orderBy('c.display_order')
    .orderBy('c.code')
    .execute();
  if (languages.length)
    optional.push({
      labelKey: 'signup.ui.language_codes',
      value: languages.map((r) => r.label_key),
    });
  if (tags.length)
    optional.push({
      labelKey: 'signup.ui.personality_tag_codes',
      value: tags.map((r) => r.label_key),
    });
  return {
    telegramUserId: profile.telegramUserId,
    name: profile.name,
    age: profile.age,
    profileVersion: profile.profileVersion,
    locationLabelKeys: [profile.city, profile.province, profile.country],
    genderLabelKey: profile.genderLabelKey,
    preferenceLabelKey: profile.preferenceLabelKey,
    goalLabelKey: profile.goalLabelKey,
    interestLabelKeys: interests.map((r) => r.label_key),
    highlight: profile.highlight,
    bio: profile.bio ?? '',
    optional,
    photos,
  };
}
