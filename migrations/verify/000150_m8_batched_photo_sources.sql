DO $$ DECLARE definition text; columns text[]; BEGIN
 SELECT pg_get_viewdef('media.report_photo_source_facts'::regclass,true) INTO definition;
 SELECT array_agg(attname::text ORDER BY attnum) INTO columns FROM pg_attribute
  WHERE attrelid='media.report_photo_source_facts'::regclass AND attnum>0 AND NOT attisdropped;
 IF columns IS DISTINCT FROM ARRAY['report_evidence_id','asset_id','variant_id','storage_key','sha256','variant_type','transformation_version']::text[]
  OR position('COALESCE' IN definition)=0
  OR position('operation.evidence_id IS NOT NULL' IN definition)=0
  OR position('operation.verified_at IS NOT NULL' IN definition)=0
  OR position('deletion_private_photo_valid' IN definition)=0 THEN
  RAISE EXCEPTION 'batched photo source custody contract missing';
 END IF;
END $$;
