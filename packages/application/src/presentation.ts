export type LocalizedIntent = Readonly<{
  key: string;
  variables: Readonly<Record<string, string | number | boolean>>;
  fallbackKey?: string;
}>;
