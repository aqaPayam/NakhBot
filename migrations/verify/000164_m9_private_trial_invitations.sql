DO $$ BEGIN
 IF to_regprocedure('platform.trial_invitation_policy(uuid)') IS NULL
 OR to_regprocedure('platform.trial_claim_epoch(uuid)') IS NULL
 OR to_regclass('platform.trial_invitation_policy_idx') IS NULL
 OR to_regclass('platform.trial_invitation_token_idx') IS NULL
 OR to_regclass('platform.trial_claim_invitation_user_idx') IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass AND tgname='trial_authority_guard' AND tgenabled='O')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass AND tgname='trial_fact_valid' AND tgenabled='O')
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='platform.redeem_trial_invitation(text,uuid,integer,text,text)'::regprocedure
  AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog'] AND NOT EXISTS(
   SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE'))
 OR EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='platform.trial-invitation-created.v1' AND platform.trial_invitation_policy(id) IS NULL)
 OR EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='platform.trial-invitation-redeemed.v1' AND platform.trial_claim_epoch(id) IS NULL)
 OR (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND text_key IN ('trial.invitation.unavailable','trial.feedback.prompt','trial.feedback.sent') AND is_active)<>3
 THEN RAISE EXCEPTION 'Private trial invitation verification failed' USING ERRCODE='55000'; END IF;
END $$;
