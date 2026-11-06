import { ApplicationError } from '@nakh/domain';
export type FullProfileDisplay = Readonly<{
  name: string;
  age: number;
  locationLabelKeys: readonly string[];
  genderLabelKey: string;
  preferenceLabelKey: string;
  goalLabelKey: string;
  interestLabelKeys: readonly string[];
  highlight: string;
  bio: string;
  optional: readonly Readonly<{ labelKey: string; value: string | number | readonly string[] }>[];
}>;
/** Presentation only. Callers must reauthorize their exact source before each
 * send. Neither the display nor its chunks belong in durable delivery metadata. */
export function fullProfileTextParts(
  profile: FullProfileDisplay,
  render: (key: string, variables: Record<string, string | number>) => string,
): readonly string[] {
  const label = (key: string): string => render(key, {});
  const text = render('profile.ui.details', {
    name: profile.name,
    age: profile.age,
    location: profile.locationLabelKeys.map(label).join(', '),
    gender: label(profile.genderLabelKey),
    preference: label(profile.preferenceLabelKey),
    goal: label(profile.goalLabelKey),
    interests: profile.interestLabelKeys.map(label).join(', '),
    highlight: profile.highlight,
    bio: profile.bio,
    optional: profile.optional
      .map((o) =>
        render('profile.ui.optional', {
          label: label(o.labelKey),
          value:
            typeof o.value === 'string' || typeof o.value === 'number'
              ? o.value
              : o.value.map(label).join(', '),
        }),
      )
      .join('\n'),
  });
  if (!text.length || text.length > 16000)
    throw new ApplicationError('internal_error', 'error.identity.user_context_invalid', 500);
  const parts: string[] = [];
  let chunk = '';
  for (const point of text) {
    if (chunk.length + point.length > 3500) {
      parts.push(chunk);
      chunk = '';
    }
    chunk += point;
  }
  if (chunk) parts.push(chunk);
  return parts;
}
