-- Original deletion safety is historical. Before a new retained-content effect,
-- also honor current native safety work, including a separately returned life.
-- No period, deployment activation, retained body or historical receipt changes.
CREATE FUNCTION identity.retained_user_safety_clear(subject uuid) RETURNS boolean
LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=subject AND state NOT IN('restricted','banned'))
  AND NOT EXISTS(SELECT 1 FROM moderation.reports WHERE target_user_id=subject AND status IN('submitted','pending_review'))
  AND NOT EXISTS(SELECT 1 FROM moderation.reports WHERE reporter_user_id=subject AND status IN('submitted','pending_review'))
  AND NOT EXISTS(SELECT 1 FROM moderation.restriction_episodes WHERE target_user_id=subject AND status='active')
  AND NOT EXISTS(SELECT 1 FROM moderation.user_appeals WHERE user_id=subject AND status IN('submitted','in_review'))
$$;

-- Release already holds User NO KEY UPDATE then Account UPDATE. Safety writers
-- share the native Account fence so an accepted hold cannot pass an erasure
-- waiting behind it. Report pairs use canonical Account order, matching ingress;
-- no conflicting User UPDATE lock is added to Account-first moderation paths.
CREATE FUNCTION identity.fence_retained_safety_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='reports' THEN
  PERFORM user_id FROM identity.accounts WHERE user_id IN(NEW.reporter_user_id,NEW.target_user_id)
   ORDER BY user_id FOR SHARE;
 ELSIF TG_TABLE_NAME='restriction_episodes' THEN
  PERFORM user_id FROM identity.accounts WHERE user_id=NEW.target_user_id FOR SHARE;
 ELSE
  PERFORM user_id FROM identity.accounts WHERE user_id=NEW.user_id FOR SHARE;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retained_report_safety_fence BEFORE INSERT ON moderation.reports
 FOR EACH ROW WHEN(NEW.status IN('submitted','pending_review')) EXECUTE FUNCTION identity.fence_retained_safety_hold();
CREATE TRIGGER retained_episode_safety_fence BEFORE INSERT ON moderation.restriction_episodes
 FOR EACH ROW WHEN(NEW.status='active') EXECUTE FUNCTION identity.fence_retained_safety_hold();
CREATE TRIGGER retained_appeal_safety_fence BEFORE INSERT ON moderation.user_appeals
 FOR EACH ROW WHEN(NEW.status IN('submitted','in_review')) EXECUTE FUNCTION identity.fence_retained_safety_hold();

-- Extend only live mutation authority. Historical validation/replay remains
-- immutable and cannot create another effect after a later safety change.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('support.content_release_valid(platform.audit_logs,boolean)'::regprocedure) INTO definition;
 IF position('identity.retained_content_release_enabled() IS NOT TRUE' IN definition)=0 THEN
  RAISE EXCEPTION 'support release authority shape changed' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,'identity.retained_content_release_enabled() IS NOT TRUE',
  'identity.retained_content_release_enabled() IS NOT TRUE OR identity.retained_user_safety_clear(root.user_id) IS NOT TRUE');
 EXECUTE definition;
END $$;
