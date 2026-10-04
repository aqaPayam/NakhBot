export type TelegramAdminQueueMenu = Readonly<{
  recipient: string;
  text: string;
  disableLinkPreviews: true;
  replyMarkup: Readonly<{
    inline_keyboard: readonly (readonly [Readonly<{ text: string; callback_data: string }>])[];
  }>;
}>;
export interface TelegramAdminQueueDelivery {
  queueMenu(input: TelegramAdminQueueMenu): Promise<void>;
  reasonPrompt(
    input: Readonly<{ recipient: string; text: string; disableLinkPreviews: true }>,
  ): Promise<number>;
}
