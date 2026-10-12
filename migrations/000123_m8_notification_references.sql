-- No normal notification body or delivery receipt is retained here. These
-- original identities support immutable safety facts and retired-ID denial.
CREATE TABLE notification.notice_reference_anchors (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  product_epoch integer NOT NULL CHECK(product_epoch>=0),
  notification_type text NOT NULL CHECK(notification_type IN(
    'like_received','nakh_received','match_created','new_chat_message','chat_unlocked',
    'liked_by_profile_unlocked','report_result','restriction_warning','ban_warning',
    'payment_success','payment_failure','pending_nakh_payment_reminder','admin_notice','safety_notice','chat_closed')),
  empty_payload boolean NOT NULL,
  threshold_episode_id uuid REFERENCES moderation.restriction_episodes(id) ON DELETE RESTRICT
);
CREATE INDEX notice_reference_owner_life_idx ON notification.notice_reference_anchors(user_id,product_epoch,id);

CREATE FUNCTION notification.original_threshold_notice_binding(subject uuid) RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT episode.id FROM notification.notifications original
    JOIN moderation.moderation_actions action ON action.notification_id=original.id
      AND action.actor_type='system' AND action.action_type='restrict_user'
    JOIN moderation.restriction_episodes episode ON episode.id=action.restriction_episode_id
    WHERE original.id=subject AND original.user_id=episode.target_user_id
      AND original.notification_type='restriction_warning' AND original.category='restriction'
      AND original.title_key='notification.restriction_warning.title'
      AND original.body_key='notification.restriction_warning.body' AND original.payload='{}'::jsonb
      AND original.payload_schema_version=1
      AND original.deduplication_key='moderation-threshold:'||episode.id::text||':restriction'
      AND EXISTS(SELECT 1 FROM notification.notification_deliveries delivery
        WHERE delivery.notification_id=original.id AND delivery.channel='telegram')
    ORDER BY episode.id LIMIT 1
$$;
INSERT INTO notification.notice_reference_anchors
  SELECT original.id,original.user_id,original.product_epoch,original.notification_type,
    original.payload='{}'::jsonb,notification.original_threshold_notice_binding(original.id)
  FROM notification.notifications original WHERE EXISTS(
    SELECT 1 FROM moderation.moderation_actions action WHERE action.notification_id=original.id);

CREATE FUNCTION notification.guard_notice_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'notice reference requires controlled release' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM notification.notifications original WHERE original.id=NEW.id
    AND original.user_id=NEW.user_id AND original.product_epoch=NEW.product_epoch
    AND original.notification_type=NEW.notification_type AND (original.payload='{}'::jsonb)=NEW.empty_payload)
    OR NEW.threshold_episode_id IS DISTINCT FROM notification.original_threshold_notice_binding(NEW.id) THEN
    RAISE EXCEPTION 'notice reference lacks exact original facts' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notice_reference_guard BEFORE INSERT OR UPDATE OR DELETE ON notification.notice_reference_anchors
  FOR EACH ROW EXECUTE FUNCTION notification.guard_notice_reference();
CREATE FUNCTION notification.create_action_notice_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.notification_id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO notification.notice_reference_anchors
    SELECT original.id,original.user_id,original.product_epoch,original.notification_type,
      original.payload='{}'::jsonb,notification.original_threshold_notice_binding(original.id)
    FROM notification.notifications original WHERE original.id=NEW.notification_id ON CONFLICT(id) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER action_notice_reference_required AFTER INSERT ON moderation.moderation_actions
  FOR EACH ROW EXECUTE FUNCTION notification.create_action_notice_reference();
ALTER TABLE moderation.moderation_actions DROP CONSTRAINT moderation_actions_notification_id_fkey;
ALTER TABLE moderation.moderation_actions ADD CONSTRAINT moderation_actions_notification_id_fkey
  FOREIGN KEY(notification_id) REFERENCES notification.notice_reference_anchors(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION notification.require_action_notice_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.notification_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM notification.notice_reference_anchors anchor JOIN notification.notifications original ON original.id=anchor.id
    JOIN identity.accounts owner ON owner.user_id=original.user_id
    WHERE anchor.id=NEW.notification_id AND anchor.user_id=original.user_id AND anchor.product_epoch=original.product_epoch
      AND anchor.product_epoch=owner.product_epoch AND owner.state<>'deleted'
      AND anchor.notification_type=original.notification_type AND anchor.empty_payload=(original.payload='{}'::jsonb)
      AND anchor.threshold_episode_id IS NOT DISTINCT FROM notification.original_threshold_notice_binding(original.id)) THEN
    RAISE EXCEPTION 'new action notice original-life reference incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER action_notice_reference_committed AFTER INSERT ON moderation.moderation_actions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notification.require_action_notice_reference();
CREATE FUNCTION notification.guard_retired_notice_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM notification.notice_reference_anchors WHERE id=NEW.id) THEN
    RAISE EXCEPTION 'retired notice identity cannot be reused' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notice_retired_identity_guard BEFORE INSERT ON notification.notifications
  FOR EACH ROW EXECUTE FUNCTION notification.guard_retired_notice_identity();

-- Until the owning archival executor exists, moving the FK must not weaken
-- the former live-body protection of existing safety records.
CREATE FUNCTION notification.require_notice_archival() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM notification.notice_reference_anchors WHERE id=OLD.id) THEN
    RAISE EXCEPTION 'notice source requires verified archival' USING ERRCODE='55000'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER notice_archival_delete_guard BEFORE DELETE ON notification.notifications
  FOR EACH ROW EXECUTE FUNCTION notification.require_notice_archival();
