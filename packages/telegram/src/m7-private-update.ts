import { ApplicationError } from '@nakh/domain';
export function m7Record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
export function requirePrivateM7Actor(
  update: unknown,
  kind: 'message' | 'callback',
): Readonly<{ updateId: number; telegramUserId: string; occurredAt: string }> {
  const root = m7Record(update),
    callback = m7Record(root?.callback_query);
  const message = kind === 'callback' ? m7Record(callback?.message) : m7Record(root?.message);
  const from = kind === 'callback' ? m7Record(callback?.from) : m7Record(message?.from);
  const chat = m7Record(message?.chat),
    updateId = root?.update_id,
    sender = from?.id,
    date = message?.date;
  if (
    typeof updateId !== 'number' ||
    !Number.isSafeInteger(updateId) ||
    updateId < 0 ||
    typeof sender !== 'number' ||
    !Number.isSafeInteger(sender) ||
    sender <= 0 ||
    from?.is_bot !== false ||
    chat?.type !== 'private' ||
    chat.id !== sender ||
    (kind === 'message' &&
      (typeof date !== 'number' || !Number.isSafeInteger(date) || date < 0 || date > 253402300799))
  )
    throw new ApplicationError('invalid_request', 'error.m7.invalid_request', 400);
  return {
    updateId,
    telegramUserId: String(sender),
    occurredAt: new Date(kind === 'message' ? (date as number) * 1000 : 0).toISOString(),
  };
}
