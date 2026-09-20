ALTER TABLE channel_telegram.liked_by_delivery_receipts
  DROP CONSTRAINT liked_by_delivery_receipts_message_key_check;

ALTER TABLE channel_telegram.liked_by_delivery_receipts
  ADD CONSTRAINT liked_by_delivery_receipt_key_ck CHECK (
    message_key ~ '^card:v1\.lb\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$'
    OR message_key ~ '^screen:[A-Za-z0-9_-]{43}$'
  );
