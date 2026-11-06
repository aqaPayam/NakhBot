DO $$ BEGIN
 IF to_regprocedure('channel_telegram.guard_liked_by_original_authority()') IS NULL
  OR (SELECT count(*) FROM pg_attribute WHERE attrelid='channel_telegram.liked_by_delivery_requests'::regclass
    AND attname IN ('session_grant_id','source_like_id','feature_unlock_id','profile_version') AND NOT attisdropped)<>4
  OR identity.retention_catalog_valid() IS NOT TRUE THEN RAISE EXCEPTION 'interactive Like authority incomplete'; END IF;
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND text_key IN(E'liked_by.back',E'liked_by.dismiss',E'liked_by.insufficient',E'liked_by.like_back',E'liked_by.menu',E'liked_by.queued',E'liked_by.rejected',E'liked_by.unavailable',E'liked_by.unlock.confirm',E'liked_by.unlock.credits',E'liked_by.view'))<>11 THEN RAISE EXCEPTION 'interactive Like presentation incomplete'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.ui_texts WHERE locale_code='en' AND text_key='liked_by.unlock.confirm' AND variables='["balance","credits"]'::jsonb) THEN RAISE EXCEPTION 'interactive Like variables invalid'; END IF;
END $$;
