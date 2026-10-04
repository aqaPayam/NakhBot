DO $$
BEGIN
  IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code = 'en' AND is_active
      AND variables = '[]'::jsonb AND value <> '' AND text_key IN (
        'admin.queue.support_title', 'admin.queue.appeals_title', 'admin.queue.choose',
        'admin.queue.empty', 'admin.queue.next', 'admin.queue.reason_prompt',
        'admin.queue.status.open', 'admin.queue.status.closed', 'admin.queue.status.submitted',
        'admin.queue.status.in_review', 'admin.queue.status.accepted', 'admin.queue.status.rejected'
      )) <> 12 THEN
    RAISE EXCEPTION 'M7 admin queue localization incomplete';
  END IF;
END $$;
