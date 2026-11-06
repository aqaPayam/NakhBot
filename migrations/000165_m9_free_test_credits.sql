-- Explicit non-cash test funding. Real provider receipts and administrator
-- adjustments retain their original meanings and constraints.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type IN
 ('platform.free-credit-test-mode-applied.v1','billing.free-test-topup-granted.v1')) THEN
  RAISE EXCEPTION 'Untrusted test funding predates its guards' USING ERRCODE='55000'; END IF;
END $$;
ALTER TABLE billing.credit_transactions DROP CONSTRAINT credit_transactions_transaction_type_check,
 DROP CONSTRAINT credit_transaction_sign_ck, DROP CONSTRAINT credit_transaction_reference_ck;
ALTER TABLE billing.credit_transactions
 ADD CONSTRAINT credit_transactions_transaction_type_check CHECK(transaction_type IN
 ('purchase','spend_nakh','spend_chat_unlock','spend_liked_by_unlock','refund','admin_adjustment','free_test_topup')),
 ADD CONSTRAINT credit_transaction_sign_ck CHECK(
 (transaction_type IN('purchase','refund','free_test_topup') AND amount>0)
 OR (transaction_type IN('spend_nakh','spend_chat_unlock','spend_liked_by_unlock') AND amount<0)
 OR transaction_type='admin_adjustment'),
 ADD CONSTRAINT credit_transaction_reference_ck CHECK(
 (transaction_type='purchase' AND payment_record_id IS NOT NULL AND feature_unlock_id IS NULL AND nakh_id IS NULL)
 OR (transaction_type='spend_nakh' AND nakh_id IS NOT NULL AND payment_record_id IS NULL AND feature_unlock_id IS NULL)
 OR (transaction_type IN('spend_chat_unlock','spend_liked_by_unlock') AND feature_unlock_id IS NOT NULL AND payment_record_id IS NULL AND nakh_id IS NULL)
 OR (transaction_type='refund' AND nakh_id IS NULL)
 OR (transaction_type IN('admin_adjustment','free_test_topup') AND payment_record_id IS NULL AND pending_payment_id IS NULL AND feature_unlock_id IS NULL AND nakh_id IS NULL));

CREATE FUNCTION platform.free_credit_test_mode_version(source_id uuid) RETURNS integer
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE a platform.audit_logs; p platform.audit_logs; v numeric; expiry timestamptz;
BEGIN
 SELECT * INTO a FROM platform.audit_logs WHERE id=source_id;
 IF a.id IS NULL OR a.category IS DISTINCT FROM 'security'
 OR a.event_type IS DISTINCT FROM 'platform.free-credit-test-mode-applied.v1'
 OR a.actor_type IS DISTINCT FROM 'system' OR a.actor_user_id IS NOT NULL OR a.actor_admin_id IS NOT NULL
 OR a.subject_type IS DISTINCT FROM 'free_credit_test_mode'
 OR a.subject_id IS DISTINCT FROM '00000000-0000-4000-8000-000000000010'::uuid
 OR a.result_code NOT IN('enabled','disabled') OR a.metadata_schema_version IS DISTINCT FROM 1
 OR a.command_id IS DISTINCT FROM a.id OR a.request_id IS DISTINCT FROM a.id
 OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>8
 OR NOT (a.metadata ?& ARRAY['operatorId','sourceSha','environment','telegramBotId','version','cohortPolicyId','expiresAt','requestDigest'])
 OR jsonb_typeof(a.metadata->'operatorId') IS DISTINCT FROM 'string'
 OR (a.metadata->>'operatorId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR jsonb_typeof(a.metadata->'sourceSha') IS DISTINCT FROM 'string' OR a.metadata->>'sourceSha' !~ '^[a-f0-9]{40}$'
 OR a.metadata->>'environment' IS DISTINCT FROM 'staging'
 OR jsonb_typeof(a.metadata->'telegramBotId') IS DISTINCT FROM 'string'
 OR a.metadata->>'telegramBotId' !~ '^[1-9][0-9]{0,15}$'
 OR (a.metadata->>'telegramBotId')::numeric>9007199254740991
 OR jsonb_typeof(a.metadata->'requestDigest') IS DISTINCT FROM 'string' OR a.metadata->>'requestDigest' !~ '^[a-f0-9]{64}$'
 OR jsonb_typeof(a.metadata->'version') IS DISTINCT FROM 'number'
 OR NOT isfinite(a.occurred_at) THEN RETURN NULL; END IF;
 v:=(a.metadata->>'version')::numeric;
 IF v<>trunc(v) OR v<1 OR v>2147483647 THEN RETURN NULL; END IF;
 IF a.result_code='disabled' THEN
  IF a.metadata->'cohortPolicyId'<>'null'::jsonb OR a.metadata->'expiresAt'<>'null'::jsonb THEN RETURN NULL; END IF;
 ELSE
  IF jsonb_typeof(a.metadata->'cohortPolicyId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(a.metadata->'expiresAt') IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
  SELECT * INTO p FROM platform.audit_logs WHERE id=(a.metadata->>'cohortPolicyId')::uuid;
  expiry:=(a.metadata->>'expiresAt')::timestamptz;
  IF platform.launch_policy_version(p.id) IS NULL OR p.result_code<>'cohort'
   OR p.metadata->>'environment'<>'staging' OR p.metadata->>'sourceSha' IS DISTINCT FROM a.metadata->>'sourceSha'
   OR p.metadata->>'telegramBotId' IS DISTINCT FROM a.metadata->>'telegramBotId'
   OR a.occurred_at<p.occurred_at OR NOT isfinite(expiry) OR expiry<=a.occurred_at
   OR expiry>(p.metadata->>'expiresAt')::timestamptz
   OR to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>a.metadata->>'expiresAt'
   THEN RETURN NULL; END IF;
 END IF;
 RETURN v::integer;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
CREATE UNIQUE INDEX free_credit_test_mode_version_idx ON platform.audit_logs(((metadata->>'version')::integer) DESC)
 WHERE event_type='platform.free-credit-test-mode-applied.v1';
CREATE TRIGGER free_credit_test_mode_owner BEFORE INSERT ON platform.audit_logs FOR EACH ROW
 WHEN (NEW.event_type='platform.free-credit-test-mode-applied.v1') EXECUTE FUNCTION platform.guard_launch_authority();
CREATE FUNCTION platform.require_free_credit_test_mode() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p platform.audit_logs;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('nakh-launch-cohort'));
 IF platform.free_credit_test_mode_version(NEW.id) IS NULL THEN
  RAISE EXCEPTION 'Invalid free credit test mode' USING ERRCODE='23514'; END IF;
 IF NEW.result_code='enabled' THEN
  SELECT * INTO p FROM platform.audit_logs WHERE event_type='platform.launch-policy-applied.v1'
   ORDER BY ((metadata->>'version')::bigint) DESC LIMIT 1;
  IF p.id IS DISTINCT FROM (NEW.metadata->>'cohortPolicyId')::uuid
   OR (NEW.metadata->>'expiresAt')::timestamptz<=clock_timestamp() THEN
   RAISE EXCEPTION 'Free test funding lacks current cohort authority' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER free_credit_test_mode_fact AFTER INSERT ON platform.audit_logs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.event_type='platform.free-credit-test-mode-applied.v1')
 EXECUTE FUNCTION platform.require_free_credit_test_mode();

CREATE FUNCTION platform.current_free_credit_test_mode(subject uuid,epoch integer,source_sha text,bot_id text)
RETURNS uuid LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE m platform.audit_logs; p platform.audit_logs;
BEGIN
 SELECT * INTO m FROM platform.audit_logs WHERE event_type='platform.free-credit-test-mode-applied.v1'
  ORDER BY ((metadata->>'version')::integer) DESC LIMIT 1;
 IF platform.free_credit_test_mode_version(m.id) IS NULL OR m.result_code<>'enabled'
  OR m.metadata->>'sourceSha' IS DISTINCT FROM source_sha OR m.metadata->>'telegramBotId' IS DISTINCT FROM bot_id
  OR (m.metadata->>'expiresAt')::timestamptz<=clock_timestamp() THEN RETURN NULL; END IF;
 SELECT * INTO p FROM platform.audit_logs WHERE event_type='platform.launch-policy-applied.v1'
  ORDER BY ((metadata->>'version')::bigint) DESC LIMIT 1;
 IF p.id IS DISTINCT FROM (m.metadata->>'cohortPolicyId')::uuid OR platform.launch_policy_version(p.id) IS NULL
  OR p.result_code<>'cohort' OR (p.metadata->>'expiresAt')::timestamptz<=clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=subject AND product_epoch=epoch AND state='active')
  THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM platform.audit_logs member WHERE member.event_type='platform.launch-cohort-granted.v1'
    AND member.subject_id=subject AND (member.metadata->>'policyId')::uuid=p.id
    AND platform.launch_member_epoch(member.id)=epoch)
 OR EXISTS(SELECT 1 FROM platform.audit_logs claim JOIN platform.audit_logs invitation
    ON invitation.id=(claim.metadata->>'invitationId')::uuid
    WHERE claim.event_type='platform.trial-invitation-redeemed.v1' AND claim.subject_id=subject
    AND platform.trial_claim_epoch(claim.id)=epoch AND platform.trial_invitation_policy(invitation.id)=p.id
    AND (invitation.metadata->>'expiresAt')::timestamptz>clock_timestamp()) THEN RETURN m.id; END IF;
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

-- Historical proof survives mode closure, session expiry and ordinary deletion.
-- Current authority is checked separately for each new write and at commit.
CREATE FUNCTION billing.free_test_topup_proof(source_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE c billing.credit_transactions; a platform.audit_logs; m platform.audit_logs; s platform.audit_logs;
BEGIN
 SELECT * INTO c FROM billing.credit_transactions WHERE id=source_id;
 SELECT * INTO a FROM platform.audit_logs WHERE id=source_id;
 IF c.id IS NULL OR c.transaction_type<>'free_test_topup' OR c.amount<>100
 OR c.payment_record_id IS NOT NULL OR c.pending_payment_id IS NOT NULL OR c.feature_unlock_id IS NOT NULL OR c.nakh_id IS NOT NULL
 OR a.id IS NULL OR a.category IS DISTINCT FROM 'product' OR a.event_type IS DISTINCT FROM 'billing.free-test-topup-granted.v1'
 OR a.actor_type IS DISTINCT FROM 'user' OR a.actor_user_id IS DISTINCT FROM c.user_id OR a.actor_admin_id IS NOT NULL
 OR a.subject_type IS DISTINCT FROM 'credit_transaction' OR a.subject_id IS DISTINCT FROM c.id
 OR a.result_code IS DISTINCT FROM 'granted' OR a.metadata_schema_version IS DISTINCT FROM 1
 OR a.request_id IS DISTINCT FROM c.correlation_id OR a.occurred_at IS DISTINCT FROM c.created_at
 OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>5
 OR NOT (a.metadata ?& ARRAY['modeId','sessionGrantId','productEpoch','credits','requestDigest'])
 OR a.metadata->'productEpoch' IS DISTINCT FROM to_jsonb(c.product_epoch)
 OR a.metadata->>'credits' IS DISTINCT FROM '100'
 OR jsonb_typeof(a.metadata->'requestDigest') IS DISTINCT FROM 'string' OR a.metadata->>'requestDigest' !~ '^[a-f0-9]{64}$'
 THEN RETURN false; END IF;
 SELECT * INTO m FROM platform.audit_logs WHERE id=(a.metadata->>'modeId')::uuid;
 SELECT * INTO s FROM platform.audit_logs WHERE id=(a.metadata->>'sessionGrantId')::uuid;
 RETURN COALESCE(platform.free_credit_test_mode_version(m.id) IS NOT NULL AND m.result_code='enabled'
  AND a.occurred_at>=m.occurred_at AND a.occurred_at<(m.metadata->>'expiresAt')::timestamptz
  AND identity.user_session_epoch(s.id)=c.product_epoch AND s.actor_user_id=c.user_id
  AND a.occurred_at>=s.occurred_at AND a.occurred_at<(s.metadata->>'expiresAt')::timestamptz,false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION billing.require_free_test_topup_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c billing.credit_transactions; a platform.audit_logs; m platform.audit_logs; s platform.audit_logs; selected uuid;
BEGIN
 -- Both rows must have the same immutable id. Resolve this trigger's own row,
 -- so an extra audit cannot borrow the proof of an earlier valid credit.
 selected:=NEW.id;
 SELECT * INTO c FROM billing.credit_transactions WHERE id=selected;
 SELECT * INTO a FROM platform.audit_logs WHERE id=selected;
 IF billing.free_test_topup_proof(selected) IS NOT TRUE THEN
  RAISE EXCEPTION 'Free credit grant lacks its exact ledger proof' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('nakh-launch-cohort'));
 SELECT * INTO m FROM platform.audit_logs WHERE id=(a.metadata->>'modeId')::uuid;
 SELECT * INTO s FROM platform.audit_logs WHERE id=(a.metadata->>'sessionGrantId')::uuid;
 IF platform.current_free_credit_test_mode(c.user_id,c.product_epoch,m.metadata->>'sourceSha',m.metadata->>'telegramBotId') IS DISTINCT FROM m.id
  OR identity.user_session_authority_revoked(s.id) OR (s.metadata->>'expiresAt')::timestamptz<=clock_timestamp()
  OR (SELECT count(*) FROM platform.outbox_events e WHERE e.event_type='billing.credit-increased.v1'
    AND e.payload->>'creditTransactionId'=c.id::text)<>1
  OR NOT EXISTS(SELECT 1 FROM platform.outbox_events e WHERE e.event_type='billing.credit-increased.v1'
    AND e.aggregate_type='credit_account' AND e.aggregate_id=c.user_id AND e.schema_version=1
    AND e.payload=jsonb_build_object('creditTransactionId',c.id,'amount','100','balanceAfter',c.balance_after::text)
    AND e.correlation_id=a.request_id AND e.causation_id=a.command_id AND e.occurred_at=c.created_at)
 THEN RAISE EXCEPTION 'Free credit grant authority changed or event is missing' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER free_test_topup_credit_commit AFTER INSERT ON billing.credit_transactions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.transaction_type='free_test_topup')
 EXECUTE FUNCTION billing.require_free_test_topup_commit();
CREATE CONSTRAINT TRIGGER free_test_topup_audit_commit AFTER INSERT ON platform.audit_logs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.event_type='billing.free-test-topup-granted.v1')
 EXECUTE FUNCTION billing.require_free_test_topup_commit();

DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('platform.deletion_operational_blocker(uuid)'::regprocedure) INTO definition;
 IF position('AND (audit.metadata_schema_version<>1 OR' IN definition)=0 THEN
  RAISE EXCEPTION 'Operational blocker shape changed' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,'AND (audit.metadata_schema_version<>1 OR',
  'AND CASE WHEN audit.event_type=''billing.free-test-topup-granted.v1'' THEN billing.free_test_topup_proof(audit.subject_id) IS NOT TRUE ELSE true END AND (audit.event_type=''billing.free-test-topup-granted.v1'' OR audit.metadata_schema_version<>1 OR');
 EXECUTE definition;
END $$;

WITH seed(text_key,body) AS (VALUES
 ('account.menu.title','Settings'),
 ('account.credits.title','Your credits'),
 ('account.credits.balance','Balance: {credits} credits'),
 ('account.credits.free_add','Add 100 free credits'),
 ('account.credits.free_info','You can add test credits for free, as often as you need. Pending Nakhes you already approved may use these credits automatically.'),
 ('account.credits.added','Added 100 free credits.'),
 ('account.credits.unavailable','Free credit refills are unavailable. Please open the current menu again.'),
 ('account.menu.support','Support'),
 ('account.menu.support_help','Send /support followed by your message.'),
 ('account.menu.delete','Delete account'),
 ('account.menu.delete_help','Send /delete to review and confirm account deletion.'),
 ('account.menu.back','Back to settings'))
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,
 CASE WHEN text_key IN('account.credits.free_add','account.menu.support','account.menu.delete','account.menu.back') THEN 'button' ELSE 'message' END,
 CASE WHEN text_key='account.credits.balance' THEN '["credits"]'::jsonb ELSE '[]'::jsonb END,true,
 '2026-01-01T00:00:00Z'::timestamptz,'2026-01-01T00:00:00Z'::timestamptz FROM seed;
