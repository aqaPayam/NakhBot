DO $$ BEGIN
 IF to_regprocedure('platform.free_credit_test_mode_version(uuid)') IS NULL
 OR to_regprocedure('platform.current_free_credit_test_mode(uuid,integer,text,text)') IS NULL
 OR to_regprocedure('billing.free_test_topup_proof(uuid)') IS NULL
 OR platform.free_credit_test_mode_version('00000000-0000-4000-8000-000000000000') IS NOT NULL
 OR billing.free_test_topup_proof('00000000-0000-4000-8000-000000000000') IS NOT FALSE THEN
  RAISE EXCEPTION 'Free test credit authority verification failed'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
  ('free_credit_test_mode_owner','free_credit_test_mode_fact','free_test_topup_credit_commit','free_test_topup_audit_commit'))<>4 THEN
  RAISE EXCEPTION 'Free test credit commit guards missing'; END IF;
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active
  AND text_key IN('account.menu.title','account.credits.title','account.credits.balance','account.credits.free_add',
   'account.credits.free_info','account.credits.added','account.credits.unavailable','account.menu.support',
   'account.menu.support_help','account.menu.delete','account.menu.delete_help','account.menu.back'))<>12 THEN
  RAISE EXCEPTION 'Free test credit English text missing'; END IF;
 IF position('free_test_topup' IN (SELECT pg_get_constraintdef(oid) FROM pg_constraint
  WHERE conrelid='billing.credit_transactions'::regclass AND conname='credit_transactions_transaction_type_check'))=0 THEN
  RAISE EXCEPTION 'Free test ledger kind missing'; END IF;
END $$;
