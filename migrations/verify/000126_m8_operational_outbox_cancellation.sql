DO $$ BEGIN
  IF platform.deletion_event_disposition('unknown.v1',1,'{}'::jsonb)<>'unclassified'
    OR platform.deletion_event_disposition('chat.message-created.v1',1,
      '{"chatSessionId":"10000000-0000-4000-8000-000000000001","messageId":"10000000-0000-4000-8000-000000000001","messageType":"text","text":"private"}'::jsonb)<>'unclassified'
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='platform.outbox_events'::regclass
      AND attname='deletion_cancellation_audit_id' AND NOT attisdropped)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass
      AND tgname='operational_cancellation_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.outbox_events'::regclass
      AND tgname='outbox_deletion_cancellation_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.outbox_events'::regclass
      AND tgname='outbox_post_product_guard' AND tgenabled='O') THEN
    RAISE EXCEPTION 'typed operational cancellation guards incomplete'; END IF;
END $$;
