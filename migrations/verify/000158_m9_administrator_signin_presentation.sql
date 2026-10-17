DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active
   AND text_key IN ('admin.auth.open','admin.auth.title','admin.auth.instructions',
    'admin.auth.invitation','admin.auth.begin','admin.auth.seed','admin.auth.code',
    'admin.auth.confirm','admin.auth.signin','admin.auth.activated','admin.auth.signed_in',
    'admin.auth.signed_out','admin.auth.signout','admin.auth.unavailable','admin.auth.expired')
   AND category='admin' AND variables='[]'::jsonb)<>15 THEN
  RAISE EXCEPTION 'Administrator sign-in presentation catalog incomplete';
 END IF;
END $$;
