DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='notification.notifications'::regclass AND tgname='notice_archival_delete_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_notice_receipts'::regclass
      AND tgname='notice_archival_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_views WHERE schemaname='notification' AND viewname='archived_notice_facts') THEN
    RAISE EXCEPTION 'owning notice archival guards incomplete'; END IF;
END $$;
