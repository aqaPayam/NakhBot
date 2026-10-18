import type { ChatMessage } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';
function unavailable(): never {
  throw new ApplicationError('chat_unavailable', 'error.chat.unavailable', 409);
}
export function projectStoredChatMessage(
  row: Readonly<{
    id: string;
    sender_user_id: string | null;
    message_type: 'predefined_question' | 'predefined_answer' | 'text' | 'system';
    text: string | null;
    predefined_question_id: string | null;
    predefined_answer_id: string | null;
    question_text_key: string | null;
    answer_question_id: string | null;
    answer_text_key: string | null;
    system_arguments: Readonly<Record<string, unknown>> | null;
    sequence_number: string;
    created_at: Date;
  }>,
  viewerUserId: string,
): ChatMessage {
  const base = {
    messageId: row.id,
    sequenceNumber: row.sequence_number,
    sender:
      row.sender_user_id === null
        ? ('system' as const)
        : row.sender_user_id === viewerUserId
          ? ('self' as const)
          : ('match' as const),
    createdAt: row.created_at.toISOString(),
  };
  switch (row.message_type) {
    case 'predefined_question':
      if (row.predefined_question_id === null || row.question_text_key === null) unavailable();
      return {
        ...base,
        messageType: 'predefined_question',
        content: { questionId: row.predefined_question_id, textKey: row.question_text_key },
      };
    case 'predefined_answer':
      if (
        row.predefined_answer_id === null ||
        row.answer_question_id === null ||
        row.answer_text_key === null
      )
        unavailable();
      return {
        ...base,
        messageType: 'predefined_answer',
        content: {
          questionId: row.answer_question_id,
          answerId: row.predefined_answer_id,
          textKey: row.answer_text_key,
        },
      };
    case 'text':
      if (row.text === null) unavailable();
      return { ...base, messageType: 'text', content: { text: row.text } };
    case 'system':
      if (row.text === null || row.system_arguments === null) unavailable();
      return {
        ...base,
        sender: 'system',
        messageType: 'system',
        content: {
          textKey: row.text,
          arguments: Object.fromEntries(
            Object.entries(row.system_arguments).map(([key, value]) => [key, String(value)]),
          ),
        },
      };
  }
}
