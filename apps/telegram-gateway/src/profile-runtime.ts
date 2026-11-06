import { createHash, randomBytes } from 'node:crypto';
import {
  UpdateOwnProfileHandler,
  RequestProtectedProfileChangeHandler,
  SaveExploreFilterHandler,
  type UserSessionActor,
} from '@nakh/application';
import type {
  UpdateProfileCommand,
  RequestProtectedProfileChangeCommand,
  SaveExploreFilterCommand,
} from '@nakh/contracts';
import { resolveSecretReference, type AppConfig } from '@nakh/config';
import { ApplicationError, SystemClock } from '@nakh/domain';
import {
  CatalogRenderer,
  M9_EDITOR_TEXTS,
  M9_SETTINGS_TEXTS,
  M9_SIGNUP_TEXTS,
  M9_FILTER_TEXTS,
} from '@nakh/localization';
import {
  PostgresProfileStore,
  PostgresExploreFilterStore,
  PostgresProfileChangeStore,
  PostgresSignupChoices,
  PostgresUserSessionStore,
  PostgresTelegramUserResolver,
  PostgresIdentityStore,
  PostgresLocalizationStore,
  SystemIdGenerator,
  type NakhDatabase,
  type OwnProfileEditSnapshot,
} from '@nakh/persistence-postgres';
import {
  RedisOwnedOpaqueTokenStore,
  RedisRateLimiter,
  type createRedisConnection,
} from '@nakh/queue-redis';
import {
  TelegramBotApiMenuClient,
  SignupNavigationTokens,
  signupRecord as record,
  type SignupNavigation as Nav,
} from '@nakh/telegram';

type OptionalDetails = NonNullable<UpdateProfileCommand['data']['patch']['optionalDetails']>;
type Patch = UpdateProfileCommand['data']['patch'];
type Choices = Awaited<ReturnType<PostgresSignupChoices['list']>>;
type Translate = (key: string, variables?: Record<string, string | number>) => string;
type State = Readonly<{
  snapshot: OwnProfileEditSnapshot;
  choices: Choices;
  locale: string;
  t: Translate;
}>;
type Field = Readonly<{
  label: string;
  catalog?: string;
  optional?: keyof OptionalDetails;
  multi?: boolean;
  text?: boolean;
}>;
const FIELDS: Readonly<Record<string, Field>> = {
  name: { label: 'profile.edit.name', text: true },
  highlight: { label: 'profile.edit.highlight', text: true },
  preference: { label: 'profile.edit.preference', catalog: 'relationship_gender_preference' },
  interests: { label: 'profile.edit.interests', catalog: 'interests', multi: true },
  goal: { label: 'profile.edit.goal', catalog: 'relationship_goal' },
  height: { label: 'signup.ui.height_cm', optional: 'heightCm', text: true },
  job: { label: 'signup.ui.job', optional: 'job', text: true },
  education: {
    label: 'signup.ui.education_level_code',
    optional: 'educationLevelCode',
    catalog: 'education_level',
  },
  smoking: {
    label: 'signup.ui.smoking_preference_code',
    optional: 'smokingPreferenceCode',
    catalog: 'smoking_preference',
  },
  pets: {
    label: 'signup.ui.pets_preference_code',
    optional: 'petsPreferenceCode',
    catalog: 'pets_preference',
  },
  exercise: {
    label: 'signup.ui.exercise_frequency_code',
    optional: 'exerciseFrequencyCode',
    catalog: 'exercise_frequency',
  },
  religion: {
    label: 'signup.ui.religion_code',
    optional: 'religionCode',
    catalog: 'religion_importance',
  },
  children: {
    label: 'signup.ui.children_preference_code',
    optional: 'childrenPreferenceCode',
    catalog: 'children_preference',
  },
  languages: {
    label: 'signup.ui.language_codes',
    optional: 'languageCodes',
    catalog: 'languageCodes',
    multi: true,
  },
  personality: {
    label: 'signup.ui.personality_tag_codes',
    optional: 'personalityTagCodes',
    catalog: 'personalityTagCodes',
    multi: true,
  },
  bio: { label: 'signup.ui.bio', optional: 'bio', text: true },
};
function denied(): never {
  throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
}
function invalid(): never {
  throw new ApplicationError('invalid_request', 'profile.edit.invalid', 400);
}
function uuid(value: string): string {
  const b = createHash('sha256').update(value).digest().subarray(0, 16);
  b[6] = (b[6]! & 15) | 0x50;
  b[8] = (b[8]! & 63) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export interface TelegramProfileRuntimePort {
  readonly enabled: boolean;
  handle(update: unknown): Promise<'unhandled' | 'notice'>;
  open(recipient: string, actor: UserSessionActor): Promise<void>;
  openFilters?(recipient: string, actor: UserSessionActor): Promise<void>;
}

/** Field text goes directly to native profile commands, never to navigation storage. */
export class TelegramProfileRuntime implements TelegramProfileRuntimePort {
  public readonly enabled = true;
  private readonly key: Buffer;
  private readonly users: PostgresTelegramUserResolver;
  private readonly identities: PostgresIdentityStore;
  private readonly sessions: PostgresUserSessionStore;
  private readonly localization: PostgresLocalizationStore;
  private readonly limiter: RedisRateLimiter;
  private readonly ids = new SystemIdGenerator();
  private readonly clock = new SystemClock();
  public constructor(
    private readonly config: AppConfig,
    private readonly database: NakhDatabase,
    private readonly redis: ReturnType<typeof createRedisConnection>,
    private readonly botId: string,
    key: Uint8Array,
    private readonly client: TelegramBotApiMenuClient,
    private readonly home?: (recipient: string, actor: UserSessionActor) => Promise<void>,
  ) {
    this.key = Buffer.from(key);
    this.users = new PostgresTelegramUserResolver(database);
    this.identities = new PostgresIdentityStore(database);
    this.sessions = new PostgresUserSessionStore(database);
    this.localization = new PostgresLocalizationStore(database);
    this.limiter = new RedisRateLimiter(redis, config.redis.queuePrefix);
  }
  public async onModuleInit(): Promise<void> {
    if (
      !(await this.database
        .selectFrom('platform.schema_migrations')
        .select('name')
        .where('name', '=', '000168_m9_explore_filter_menus.sql')
        .executeTakeFirst())
    )
      throw new Error('Profile editor schema unavailable.');
    for (const locale of await this.database
      .selectFrom('catalog.locales')
      .select('code')
      .where('is_active', '=', true)
      .execute()) {
      const catalog = await this.localization.loadActiveCatalog(locale.code);
      for (const [key, expected] of Object.entries({
        ...M9_EDITOR_TEXTS,
        ...M9_SETTINGS_TEXTS,
        ...M9_SIGNUP_TEXTS,
        ...M9_FILTER_TEXTS,
      })) {
        const value = catalog.messages[key],
          variables = (text: string): string =>
            [...new Set([...text.matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((m) => m[1]))]
              .sort()
              .join(',');
        if (typeof value !== 'string' || !value.trim() || variables(value) !== variables(expected))
          throw new Error('Profile editor localization unavailable.');
      }
    }
  }
  private tokens(recipient: string, actor: UserSessionActor): SignupNavigationTokens {
    return new SignupNavigationTokens(
      new RedisOwnedOpaqueTokenStore(this.redis, this.config.redis.queuePrefix, actor),
      this.key,
      this.botId,
      recipient,
      actor,
      Date.now,
      'profile',
    );
  }
  private async current(recipient: string, actor: UserSessionActor): Promise<string> {
    const life = await this.users.resolveProductLife(recipient);
    if (
      life?.userId !== actor.userId ||
      life.productEpoch !== actor.productEpoch ||
      !(await this.sessions.current(actor, actor.sessionGrantId))
    )
      denied();
    const identity = await this.identities.getByUserId(actor.userId);
    if (!identity || !['active', 'restricted'].includes(identity.accountState)) denied();
    return identity.uiLocale;
  }
  private async state(recipient: string, actor: UserSessionActor): Promise<State> {
    const locale = await this.current(recipient, actor),
      snapshot = await new PostgresProfileStore(this.database, actor).getOwnEditSnapshot(
        actor.userId,
      );
    if (!snapshot) throw new ApplicationError('not_found', 'profile.edit.invalid', 404);
    const choices = await new PostgresSignupChoices(this.database, actor).list(),
      catalog = await this.localization.loadActiveCatalog(locale);
    const renderer = new CatalogRenderer(
      { [catalog.resolvedLocale]: catalog.messages },
      catalog.resolvedLocale,
    );
    return {
      snapshot,
      choices,
      locale,
      t: (key, variables = {}) => renderer.render(catalog.resolvedLocale, { key, variables }),
    };
  }
  private label(state: State, kind: string, code: string): string {
    const choice = state.choices.catalogs[kind]?.find((v) => v.code === code);
    return choice ? state.t(choice.labelKey) : code;
  }
  private value(state: State, field: string): string | string[] | number | undefined {
    const p = state.snapshot.profile,
      f = FIELDS[field];
    if (f?.optional) return state.snapshot.optionalDetails[f.optional];
    if (field === 'name') return p.name;
    if (field === 'highlight') return p.highlight;
    if (field === 'preference') return p.relationshipGenderPreferenceCode;
    if (field === 'goal') return p.relationshipGoalCode;
    if (field === 'interests') return p.interestCodes;
    return undefined;
  }
  private async send(
    recipient: string,
    actor: UserSessionActor,
    text: string,
    keyboard: Array<Array<{ text: string; callback_data: string }>> = [],
  ): Promise<void> {
    await this.current(recipient, actor);
    await this.client.sendMenu(recipient, { text, replyMarkup: { inline_keyboard: keyboard } });
  }
  private async render(
    recipient: string,
    actor: UserSessionActor,
    input: Partial<Nav> = {},
    notice?: string,
  ): Promise<void> {
    const s = await this.state(recipient, actor),
      p = s.snapshot.profile,
      t = s.t;
    const nav: Nav = {
      ...input,
      actor,
      version: p.version,
      screen: input.screen ?? 'root',
      action: 'resume',
      group: randomBytes(12).toString('base64url'),
    };
    const tokens = this.tokens(recipient, actor),
      keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    const button = async (
      text: string,
      action: Nav['action'],
      extra: Partial<Nav> = {},
    ): Promise<void> => {
      keyboard.push([{ text, callback_data: await tokens.button({ ...nav, action, ...extra }) }]);
    };
    const lines = [t('profile.edit.title')];
    if (notice) lines.push(t(notice));
    if (nav.screen === 'root') {
      lines.push(
        t('profile.edit.summary', {
          name: p.name,
          year: p.birthYear,
          gender: this.label(s, 'gender', p.genderCode),
          preference: this.label(
            s,
            'relationship_gender_preference',
            p.relationshipGenderPreferenceCode,
          ),
          interests: p.interestCodes.map((code) => this.label(s, 'interests', code)).join(', '),
          location: [
            this.label(s, 'country', p.countryCode),
            this.label(s, 'province', p.provinceCode),
            this.label(s, 'city', p.cityCode),
          ].join(' / '),
          goal: this.label(s, 'relationship_goal', p.relationshipGoalCode),
          highlight: p.highlight,
        }),
      );
      for (const field of ['name', 'preference', 'interests', 'goal', 'highlight'])
        await button(t(FIELDS[field]!.label), 'pick', { field, code: undefined });
      await button(t('profile.edit.location'), 'page', {
        screen: 'country',
        field: undefined,
        page: 0,
      });
      await button(t('profile.edit.optional'), 'page', { screen: 'optional', field: undefined });
      await button(t('profile.edit.photos'), 'pick', { field: 'photos' });
      await button(t('profile.edit.request_change'), 'page', {
        screen: 'corrections',
        field: undefined,
      });
      await button(t('profile.edit.requests'), 'page', { screen: 'requests', field: undefined });
      await button(t('account.menu.home'), 'home');
    } else if (nav.screen === 'optional') {
      for (const [field, f] of Object.entries(FIELDS).filter(([, f]) => f.optional !== undefined)) {
        const value = this.value(s, field),
          display = Array.isArray(value)
            ? value.map((code) => this.label(s, f.catalog!, code)).join(', ')
            : value === undefined
              ? t('profile.edit.empty')
              : f.catalog
                ? this.label(s, f.catalog, String(value))
                : String(value);
        lines.push(
          t('profile.edit.current', {
            label: t(f.label),
            value: display || t('profile.edit.empty'),
          }),
        );
        await button(t(f.label), 'pick', { field, screen: 'field', code: undefined, page: 0 });
      }
      await button(t('signup.ui.back'), 'resume', { screen: 'root', field: undefined });
    } else if (nav.screen === 'corrections') {
      await button(t('profile.edit.birth_year'), 'pick', { field: 'protected_birth_year' });
      await button(t('profile.edit.gender'), 'page', {
        screen: 'field',
        field: 'protected_gender',
        page: 0,
      });
      await button(t('signup.ui.back'), 'resume', { screen: 'root', field: undefined });
    } else if (nav.screen === 'requests') {
      const requests = await new PostgresProfileChangeStore(
        this.database,
        actor,
      ).listOwnProtectedChanges(actor.userId);
      if (!requests.length) lines.push(t('profile.edit.requests_empty'));
      for (const request of requests)
        lines.push(
          t('profile.edit.request_row', {
            field: t(
              request.field === 'gender' ? 'profile.edit.gender' : 'profile.edit.birth_year',
            ),
            value:
              request.field === 'gender'
                ? this.label(s, 'gender', String(request.requestedValue))
                : String(request.requestedValue),
            status: t('profile.edit.status.' + request.status),
          }),
        );
      await button(t('signup.ui.back'), 'resume', { screen: 'root', field: undefined });
    } else {
      const location = ['country', 'province', 'city'].includes(nav.screen),
        field = nav.field === undefined ? undefined : FIELDS[nav.field];
      const kind = location
        ? nav.screen
        : nav.field === 'protected_gender'
          ? 'gender'
          : field?.catalog;
      if (!kind) invalid();
      let choices = s.choices.catalogs[kind] ?? [];
      if (nav.screen === 'province') choices = choices.filter((c) => c.parent === nav.country);
      if (nav.screen === 'city')
        choices = choices.filter((c) => c.parent === `${nav.country}/${nav.province}`);
      if (field)
        lines.push(
          t('profile.edit.current', {
            label: t(field.label),
            value: field.multi
              ? t(nav.field === 'interests' ? 'profile.edit.multi' : 'profile.edit.multi_optional')
              : String(this.value(s, nav.field!) ?? t('profile.edit.empty')),
          }),
        );
      const page = Math.max(
          0,
          Math.min(nav.page ?? 0, Math.max(0, Math.ceil(choices.length / 10) - 1)),
        ),
        selected = this.value(s, nav.field ?? '');
      for (const choice of choices.slice(page * 10, page * 10 + 10))
        await button(
          (Array.isArray(selected) && selected.includes(choice.code) ? '✓ ' : '') +
            t(choice.labelKey),
          'save',
          {
            code: choice.code,
            reason: field?.multi
              ? Array.isArray(selected) && selected.includes(choice.code)
                ? 'remove'
                : 'add'
              : undefined,
          },
        );
      if (page > 0) await button(t('signup.ui.back'), 'page', { page: page - 1 });
      if ((page + 1) * 10 < choices.length)
        await button(t('signup.ui.next'), 'page', { page: page + 1 });
      if (field?.optional) await button(t('signup.ui.remove'), 'clear');
      await button(t('account.menu.home'), 'resume', {
        screen: field?.optional ? 'optional' : 'root',
        field: undefined,
        code: undefined,
        page: undefined,
      });
    }
    await this.send(recipient, actor, lines.join('\n\n'), keyboard);
  }
  private envelope(
    actor: UserSessionActor,
    recipient: string,
    updateId: number,
    nav: Nav,
    locale: string,
  ): Readonly<{
    commandId: string;
    requestId: string;
    schemaVersion: 1;
    actor: { kind: 'user'; userId: string };
    idempotencyKey: string;
    occurredAt: string;
    locale: string;
  }> {
    const key = JSON.stringify([
      'profile-edit',
      this.botId,
      recipient,
      actor.userId,
      actor.productEpoch,
      actor.sessionGrantId,
      nav.group,
      nav.field,
      nav.code,
      nav.action,
      nav.reason,
      nav.action === 'reply' ? updateId : null,
    ]);
    return {
      commandId: uuid(key),
      requestId: uuid(key + ':request'),
      schemaVersion: 1,
      actor: { kind: 'user', userId: actor.userId },
      idempotencyKey: createHash('sha256').update(key).digest('hex'),
      occurredAt: this.clock.now().toISOString(),
      locale,
    };
  }
  private async prompt(recipient: string, actor: UserSessionActor, nav: Nav): Promise<void> {
    const s = await this.state(recipient, actor),
      f = FIELDS[nav.field ?? ''];
    const text =
      nav.field === 'protected_birth_year'
        ? s.t('profile.edit.birth_request')
        : nav.field === 'protected_gender'
          ? s.t('profile.edit.gender_request')
          : f
            ? s.t('profile.edit.reply', { label: s.t(f.label) })
            : invalid();
    await this.current(recipient, actor);
    const id = await this.client.sendPrompt(recipient, text);
    await this.tokens(recipient, actor).prompt(id, {
      ...nav,
      version: s.snapshot.profile.version,
      action: 'reply',
      group: randomBytes(12).toString('base64url'),
    });
    if (f?.optional)
      await this.send(recipient, actor, s.t('signup.ui.choose'), [
        [
          {
            text: s.t('signup.ui.remove'),
            callback_data: await this.tokens(recipient, actor).button({
              ...nav,
              version: s.snapshot.profile.version,
              action: 'clear',
              group: randomBytes(12).toString('base64url'),
            }),
          },
        ],
      ]);
  }
  private async save(
    recipient: string,
    actor: UserSessionActor,
    updateId: number,
    nav: Nav,
    text?: string,
  ): Promise<void> {
    const s = await this.state(recipient, actor),
      f = FIELDS[nav.field ?? ''];
    const base = this.envelope(actor, recipient, updateId, nav, s.locale);
    if (nav.field === 'protected_birth_year' || nav.field === 'protected_gender') {
      if (text === undefined) invalid();
      let data: RequestProtectedProfileChangeCommand['data'];
      if (nav.field === 'protected_birth_year') {
        const [year, ...reason] = text.trim().split(/\r?\n/u);
        if (!year || !/^\d{4}$/u.test(year) || !reason.join('\n').trim()) invalid();
        data = {
          field: 'birth_year',
          requestedValue: Number(year),
          reason: reason.join('\n'),
          expectedProfileVersion: nav.version,
        };
      } else {
        if (!nav.code) invalid();
        data = {
          field: 'gender',
          requestedValue: nav.code,
          reason: text,
          expectedProfileVersion: nav.version,
        };
      }
      await new RequestProtectedProfileChangeHandler(
        new PostgresProfileChangeStore(this.database, actor),
        this.ids,
        this.clock,
      ).execute({ ...base, commandType: 'profile.request-protected-change', data });
      await this.render(recipient, actor, { screen: 'requests' }, 'profile.edit.request_sent');
      return;
    }
    let patch: Patch;
    if (nav.screen === 'city') {
      if (!nav.country || !nav.province || !nav.code) invalid();
      patch = { countryCode: nav.country, provinceCode: nav.province, cityCode: nav.code };
    } else if (!f) invalid();
    else if (f.optional) {
      const optional: OptionalDetails = { ...s.snapshot.optionalDetails };
      if (nav.action === 'clear') delete optional[f.optional];
      else if (f.multi) {
        if (!nav.code) invalid();
        const existing = this.value(s, nav.field!);
        if (!Array.isArray(existing)) invalid();
        if (!['add', 'remove'].includes(nav.reason ?? '')) invalid();
        const values =
          nav.reason === 'remove'
            ? existing.filter((v) => v !== nav.code)
            : existing.includes(nav.code)
              ? existing
              : [...existing, nav.code];
        if (f.optional === 'languageCodes') optional.languageCodes = values;
        else if (f.optional === 'personalityTagCodes') optional.personalityTagCodes = values;
        else invalid();
      } else if (f.optional === 'heightCm') {
        if (text === undefined || !/^\d{3}$/u.test(text.trim())) invalid();
        optional.heightCm = Number(text.trim());
      } else {
        const value = f.text ? text : nav.code;
        if (value === undefined) invalid();
        if (f.optional === 'job') optional.job = value;
        else if (f.optional === 'bio') optional.bio = value;
        else if (f.optional === 'educationLevelCode') optional.educationLevelCode = value;
        else if (f.optional === 'smokingPreferenceCode') optional.smokingPreferenceCode = value;
        else if (f.optional === 'petsPreferenceCode') optional.petsPreferenceCode = value;
        else if (f.optional === 'exerciseFrequencyCode') optional.exerciseFrequencyCode = value;
        else if (f.optional === 'religionCode') optional.religionCode = value;
        else if (f.optional === 'childrenPreferenceCode') optional.childrenPreferenceCode = value;
        else invalid();
      }
      patch = { optionalDetails: optional };
    } else if (nav.field === 'name' && text !== undefined) patch = { name: text };
    else if (nav.field === 'highlight' && text !== undefined) patch = { highlight: text };
    else if (nav.field === 'preference' && nav.code)
      patch = { relationshipGenderPreferenceCode: nav.code };
    else if (nav.field === 'goal' && nav.code) patch = { relationshipGoalCode: nav.code };
    else if (nav.field === 'interests' && nav.code) {
      const old = s.snapshot.profile.interestCodes;
      if (!['add', 'remove'].includes(nav.reason ?? '')) invalid();
      patch = {
        interestCodes:
          nav.reason === 'remove'
            ? old.filter((v) => v !== nav.code)
            : old.includes(nav.code)
              ? old
              : [...old, nav.code],
      };
    } else invalid();
    await new UpdateOwnProfileHandler(
      new PostgresProfileStore(this.database, actor),
      this.ids,
      this.clock,
    ).execute({
      ...base,
      commandType: 'profile.update',
      data: { expectedProfileVersion: nav.version, patch },
    });
    await this.render(
      recipient,
      actor,
      f?.multi
        ? { screen: 'field', field: nav.field, page: nav.page }
        : f?.optional
          ? { screen: 'optional' }
          : { screen: 'root' },
      'profile.edit.saved',
    );
  }
  private async renderFilters(
    recipient: string,
    actor: UserSessionActor,
    input: Partial<Nav> = {},
    notice?: string,
  ): Promise<void> {
    const s = await this.state(recipient, actor),
      t = s.t,
      f = await new PostgresExploreFilterStore(this.database, actor).getOwnFilter(actor.userId);
    const nav: Nav = {
      ...input,
      actor,
      version: s.snapshot.profile.version,
      reference: input.reference ?? String(f.version ?? 0),
      screen: input.screen ?? 'filter_root',
      action: 'resume',
      group: randomBytes(12).toString('base64url'),
    };
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [],
      tokens = this.tokens(recipient, actor);
    const button = async (
      text: string,
      action: Nav['action'],
      extra: Partial<Nav> = {},
    ): Promise<void> => {
      keyboard.push([{ text, callback_data: await tokens.button({ ...nav, action, ...extra }) }]);
    };
    const lines = [t('filters.title')];
    if (notice) lines.push(t(notice));
    if (f.preferenceAdjusted) lines.push(t('filters.preference_adjusted'));
    if (nav.screen === 'filter_root') {
      lines.push(
        t('filters.summary', {
          genders: f.allowedGenders
            .filter((g) => f.targetGenderOptionIds.includes(g.id))
            .map((g) => t(g.labelKey))
            .join(', '),
          min: f.minAge,
          max: f.maxAge,
          location: [f.city.countryLabelKey, f.city.provinceLabelKey, f.city.labelKey]
            .map((key) => t(key))
            .join(' / '),
          goal: f.relationshipGoalCode
            ? this.label(s, 'relationship_goal', f.relationshipGoalCode)
            : t('filters.any'),
        }),
      );
      for (const [field, key] of [
        ['genders', 'filters.genders'],
        ['min', 'filters.min_age'],
        ['max', 'filters.max_age'],
        ['country', 'filters.location'],
        ['goal', 'filters.goal'],
      ] as const)
        await button(t(key), 'page', {
          screen: 'filter_' + field,
          page: 0,
          field: undefined,
          code: undefined,
        });
      await button(t('filters.apply'), 'save', { field: 'filter_apply' });
      await button(t('account.menu.home'), 'home');
    } else {
      const screen = nav.screen.slice('filter_'.length);
      let choices: Array<{ code: string; label: string; selected?: boolean }>;
      if (screen === 'genders')
        choices = f.allowedGenders.map((g) => ({
          code: g.code,
          label: t(g.labelKey),
          selected: f.targetGenderOptionIds.includes(g.id),
        }));
      else if (screen === 'min' || screen === 'max') {
        const low = screen === 'min' ? 18 : f.minAge,
          high = screen === 'max' ? 120 : f.maxAge;
        choices = Array.from({ length: high - low + 1 }, (_, n) => ({
          code: String(low + n),
          label: String(low + n),
        }));
      } else if (['country', 'province', 'city', 'goal'].includes(screen)) {
        let rows = s.choices.catalogs[screen === 'goal' ? 'relationship_goal' : screen] ?? [];
        if (screen === 'province') rows = rows.filter((r) => r.parent === nav.country);
        if (screen === 'city')
          rows = rows.filter((r) => r.parent === `${nav.country}/${nav.province}`);
        choices = rows.map((r) => ({ code: r.code, label: t(r.labelKey) }));
        if (screen === 'goal')
          await button(t('filters.any'), 'clear', { field: 'filter_goal', code: undefined });
      } else invalid();
      const page = Math.max(
        0,
        Math.min(nav.page ?? 0, Math.max(0, Math.ceil(choices.length / 10) - 1)),
      );
      for (const choice of choices.slice(page * 10, page * 10 + 10))
        await button((choice.selected ? '✓ ' : '') + choice.label, 'save', {
          field: 'filter_' + screen,
          code: choice.code,
          reason: choice.selected ? 'remove' : 'add',
        });
      if (page > 0) await button(t('signup.ui.back'), 'page', { page: page - 1 });
      if ((page + 1) * 10 < choices.length)
        await button(t('signup.ui.next'), 'page', { page: page + 1 });
      await button(t('filters.title'), 'resume', {
        screen: 'filter_root',
        field: undefined,
        code: undefined,
        page: undefined,
      });
    }
    await this.send(recipient, actor, lines.join('\n\n'), keyboard);
  }
  private async filterAction(
    recipient: string,
    actor: UserSessionActor,
    updateId: number,
    nav: Nav,
  ): Promise<void> {
    if (nav.action === 'save' && nav.screen === 'filter_country') {
      if (!nav.code) invalid();
      await this.renderFilters(recipient, actor, {
        ...nav,
        screen: 'filter_province',
        country: nav.code,
        province: undefined,
        code: undefined,
        page: 0,
      });
      return;
    }
    if (nav.action === 'save' && nav.screen === 'filter_province') {
      if (!nav.code || !nav.country) invalid();
      await this.renderFilters(recipient, actor, {
        ...nav,
        screen: 'filter_city',
        province: nav.code,
        code: undefined,
        page: 0,
      });
      return;
    }
    if (nav.action !== 'save' && nav.action !== 'clear') {
      await this.renderFilters(recipient, actor, nav);
      return;
    }
    const s = await this.state(recipient, actor),
      store = new PostgresExploreFilterStore(this.database, actor),
      f = await store.getOwnFilter(actor.userId);
    if (
      !nav.reference ||
      !/^(0|[1-9][0-9]*)$/u.test(nav.reference) ||
      !Number.isSafeInteger(Number(nav.reference))
    )
      invalid();
    let genders = [...f.targetGenderOptionIds],
      min = f.minAge,
      max = f.maxAge,
      cityId = f.city.id,
      goal = f.relationshipGoalCode;
    if (nav.field === 'filter_genders') {
      const gender = f.allowedGenders.find((g) => g.code === nav.code);
      if (!gender || !['add', 'remove'].includes(nav.reason ?? '')) invalid();
      genders =
        nav.reason === 'remove'
          ? genders.filter((id) => id !== gender.id)
          : [...new Set([...genders, gender.id])];
    } else if (nav.field === 'filter_min' || nav.field === 'filter_max') {
      if (!nav.code || !/^[0-9]{2,3}$/u.test(nav.code)) invalid();
      if (nav.field === 'filter_min') min = Number(nav.code);
      else max = Number(nav.code);
    } else if (nav.field === 'filter_goal') {
      if (nav.action === 'clear') goal = undefined;
      else {
        if (!nav.code) invalid();
        goal = nav.code;
      }
    } else if (nav.field === 'filter_city') {
      if (!nav.country || !nav.province || !nav.code) invalid();
      const city = await this.database
        .selectFrom('catalog.cities as c')
        .innerJoin('catalog.provinces as p', 'p.id', 'c.province_id')
        .innerJoin('catalog.countries as n', 'n.id', 'p.country_id')
        .select('c.id')
        .where('c.code', '=', nav.code)
        .where('p.code', '=', nav.province)
        .where('n.code', '=', nav.country)
        .where('c.is_active', '=', true)
        .where('p.is_active', '=', true)
        .where('n.is_active', '=', true)
        .executeTakeFirst();
      if (!city) invalid();
      cityId = city.id;
    } else if (nav.field !== 'filter_apply') invalid();
    const data: SaveExploreFilterCommand['data'] = {
      targetGenderOptionIds: genders,
      minAge: min,
      maxAge: max,
      cityId,
      ...(goal === undefined ? {} : { relationshipGoalCode: goal }),
      ...(nav.reference === '0' ? {} : { expectedVersion: Number(nav.reference) }),
    };
    await new SaveExploreFilterHandler(store, this.ids, this.clock).execute({
      ...this.envelope(actor, recipient, updateId, nav, s.locale),
      commandType: 'discovery.save-explore-filter',
      data,
    });
    await this.renderFilters(recipient, actor, {}, 'filters.saved');
  }
  public async openFilters(recipient: string, input: UserSessionActor): Promise<void> {
    await this.renderFilters(recipient, Object.freeze({ ...input }));
  }
  public async open(recipient: string, input: UserSessionActor): Promise<void> {
    await this.render(recipient, Object.freeze({ ...input }));
  }
  public async handle(input: unknown): Promise<'unhandled' | 'notice'> {
    const root = record(structuredClone(input)),
      message = record(root?.message),
      callback = record(root?.callback_query);
    const data =
      typeof callback?.data === 'string' && callback.data.startsWith('m9p:')
        ? callback.data
        : undefined;
    const filterCommand = message?.text === '/filters',
      command = message?.text === '/edit_profile' || filterCommand,
      reply = record(message?.reply_to_message),
      replyFrom = record(reply?.from);
    const replyId =
      replyFrom?.is_bot === true &&
      String(replyFrom.id) === this.botId &&
      typeof reply?.message_id === 'number' &&
      Number.isSafeInteger(reply.message_id)
        ? reply.message_id
        : undefined;
    if (!command && data === undefined && replyId === undefined) return 'unhandled';
    const from = record(callback?.from ?? message?.from),
      chat = record(callback === undefined ? message?.chat : record(callback.message)?.chat);
    const sender = from?.id,
      updateId = root?.update_id,
      bot = record(record(callback?.message)?.from);
    if (
      typeof sender !== 'number' ||
      !Number.isSafeInteger(sender) ||
      sender <= 0 ||
      from?.is_bot !== false ||
      chat?.type !== 'private' ||
      chat.id !== sender ||
      typeof updateId !== 'number' ||
      !Number.isSafeInteger(updateId) ||
      updateId < 0 ||
      (callback !== undefined && message !== undefined) ||
      (callback !== undefined &&
        (bot?.is_bot !== true ||
          String(bot.id) !== this.botId ||
          typeof callback.id !== 'string' ||
          !callback.id.length ||
          callback.id.length > 128))
    )
      invalid();
    const recipient = String(sender),
      life = await this.users.resolveProductLife(recipient);
    if (!life) {
      if (!command && data === undefined) return 'unhandled';
      denied();
    }
    let actor: UserSessionActor, nav: Nav | undefined;
    if (command) {
      const grant = await this.sessions.issue(
        life,
        uuid(JSON.stringify(['profile-entry', this.botId, recipient, life, updateId])),
      );
      if (!grant) denied();
      actor = Object.freeze({ kind: 'user', ...life, sessionGrantId: grant.id });
    } else {
      const lookup = new SignupNavigationTokens(
        new RedisOwnedOpaqueTokenStore(this.redis, this.config.redis.queuePrefix, life),
        this.key,
        this.botId,
        recipient,
        life,
        Date.now,
        'profile',
      );
      nav = data === undefined ? await lookup.reply(replyId!) : await lookup.callback(data);
      if (!nav) {
        if (data === undefined) return 'unhandled';
        denied();
      }
      actor = Object.freeze({ ...nav.actor });
    }
    await this.current(recipient, actor);
    if (
      !(
        await this.limiter.consume({
          scope: 'profile_write',
          subject: actor.userId,
          limit: 60,
          windowSeconds: 60,
        })
      ).allowed
    )
      throw new ApplicationError('rate_limited', 'error.rate_limit.exceeded', 429);
    try {
      if (callback !== undefined) await this.client.answerCallback(String(callback.id));
      if (command) {
        if (filterCommand) await this.renderFilters(recipient, actor);
        else await this.render(recipient, actor);
        return 'notice';
      }
      if (!nav) invalid();
      if (nav.action === 'home') {
        if (this.home) await this.home(recipient, actor);
        else await this.render(recipient, actor);
        return 'notice';
      }
      if (nav.screen.startsWith('filter_')) {
        await this.filterAction(recipient, actor, updateId, nav);
        return 'notice';
      }
      if (nav.action === 'reply') {
        if (typeof message?.text !== 'string') invalid();
        await this.save(recipient, actor, updateId, nav, message.text);
        return 'notice';
      }
      if (nav.action === 'pick') {
        if (nav.field === 'photos') {
          const s = await this.state(recipient, actor);
          await this.send(recipient, actor, s.t('profile.edit.photos_help'));
          return 'notice';
        }
        if (nav.field === 'protected_birth_year' || FIELDS[nav.field ?? '']?.text)
          await this.prompt(recipient, actor, nav);
        else await this.render(recipient, actor, { ...nav, screen: 'field', page: 0 });
      } else if (nav.action === 'save') {
        if (nav.screen === 'country') {
          if (!nav.code) invalid();
          await this.render(recipient, actor, { screen: 'province', country: nav.code, page: 0 });
        } else if (nav.screen === 'province') {
          if (!nav.code || !nav.country) invalid();
          await this.render(recipient, actor, {
            screen: 'city',
            country: nav.country,
            province: nav.code,
            page: 0,
          });
        } else if (nav.field === 'protected_gender') {
          if (!nav.code) invalid();
          await this.prompt(recipient, actor, nav);
        } else await this.save(recipient, actor, updateId, nav);
      } else if (nav.action === 'clear') await this.save(recipient, actor, updateId, nav);
      else await this.render(recipient, actor, nav);
      return 'notice';
    } catch (error) {
      if (
        !(error instanceof ApplicationError) ||
        error.status >= 500 ||
        error.status === 401 ||
        error.status === 403
      )
        throw error;
      if (filterCommand || nav?.screen.startsWith('filter_')) {
        await this.renderFilters(
          recipient,
          actor,
          {},
          error.status === 409 ? 'filters.changed' : 'filters.invalid',
        );
        return 'notice';
      }
      await this.render(
        recipient,
        actor,
        {},
        error.status === 409 ? 'profile.edit.changed' : 'profile.edit.invalid',
      );
      return 'notice';
    }
  }
}

export function createTelegramProfileRuntime(
  input: Readonly<{
    config: AppConfig;
    database: NakhDatabase;
    redis: ReturnType<typeof createRedisConnection>;
    home?: (recipient: string, actor: UserSessionActor) => Promise<void>;
    resolveSecret?: (reference: string) => string;
  }>,
): TelegramProfileRuntimePort {
  if (!input.config.telegram.accountMenuEnabled)
    return {
      enabled: false,
      handle: () => Promise.resolve('unhandled'),
      open: () =>
        Promise.reject(new ApplicationError('capability_denied', 'error.capability.denied', 403)),
    };
  const resolve = input.resolveSecret ?? resolveSecretReference,
    token = resolve(input.config.telegram.botTokenRef),
    match = /^([1-9][0-9]{0,19}):[A-Za-z0-9_-]{20,}$/u.exec(token);
  const encoded = resolve(input.config.telegram.actionTokenKeyRef),
    key = Buffer.from(encoded, 'base64url');
  if (
    match === null ||
    !Number.isSafeInteger(Number(match[1])) ||
    key.byteLength !== 32 ||
    key.toString('base64url') !== encoded
  )
    throw new Error('Profile editor credentials unavailable.');
  return new TelegramProfileRuntime(
    input.config,
    input.database,
    input.redis,
    match[1]!,
    key,
    new TelegramBotApiMenuClient(token),
    input.home,
  );
}
