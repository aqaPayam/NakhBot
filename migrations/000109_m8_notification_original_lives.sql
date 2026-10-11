-- No return has been enabled. Reject unprovable historical recipients rather
-- than binding an original notice to a later Account life.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM notification.notifications original
    LEFT JOIN identity.accounts owner ON owner.user_id=original.user_id
    WHERE owner.product_epoch IS DISTINCT FROM 0) THEN
    RAISE EXCEPTION 'legacy notification lacks its original recipient life' USING ERRCODE='23514';
  END IF;
END $$;
ALTER TABLE notification.notifications ADD COLUMN product_epoch integer NOT NULL DEFAULT 0 CHECK(product_epoch>=0);

CREATE FUNCTION notification.guard_notification_product_life() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_epoch integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.product_epoch<>OLD.product_epoch THEN
      RAISE EXCEPTION 'notification recipient life is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Existing product writers can already hold Account locks. Reacquiring a User
  -- lock here would reverse their User -> Account order. Account alone fences
  -- recipient life; immutable history updates deliberately take no such lock.
  SELECT product_epoch INTO original_epoch FROM identity.accounts WHERE user_id=NEW.user_id FOR UPDATE;
  IF original_epoch IS NULL OR (NEW.product_epoch<>0 AND NEW.product_epoch<>original_epoch) THEN
    RAISE EXCEPTION 'notification requires its exact recipient life' USING ERRCODE='40001';
  END IF;
  -- New notices are stamped under the locked recipient. This includes durable
  -- original-payment correction notices while deleted; rendering remains denied.
  NEW.product_epoch:=original_epoch;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_product_life_guard BEFORE INSERT OR UPDATE ON notification.notifications
  FOR EACH ROW EXECUTE FUNCTION notification.guard_notification_product_life();

-- Read-only product authority, separate from retained historical source facts.
CREATE VIEW interaction.current_like_lives AS
  SELECT source.* FROM interaction.likes source
  JOIN identity.accounts sender ON sender.user_id=source.sender_user_id
    AND sender.product_epoch=source.sender_product_epoch AND sender.state<>'deleted'
  JOIN identity.accounts receiver ON receiver.user_id=source.receiver_user_id
    AND receiver.product_epoch=source.receiver_product_epoch AND receiver.state<>'deleted';

CREATE VIEW matching.current_match_lives AS
  SELECT original.* FROM matching.matches original WHERE
    (original.source='mutual_like' AND EXISTS(
      SELECT 1 FROM interaction.current_like_lives first_like
      JOIN interaction.current_like_lives second_like ON second_like.id=original.source_like_b_id
        AND first_like.sender_user_id=second_like.receiver_user_id AND first_like.receiver_user_id=second_like.sender_user_id
      WHERE first_like.id=original.source_like_a_id
        AND LEAST(first_like.sender_user_id,first_like.receiver_user_id)=original.user_low_id
        AND GREATEST(first_like.sender_user_id,first_like.receiver_user_id)=original.user_high_id))
    OR (original.source='nakh_accept' AND EXISTS(
      SELECT 1 FROM nakh.nakhes delivered JOIN nakh.current_flow_lives flow ON flow.id=delivered.nakh_flow_id
      WHERE delivered.id=original.source_nakh_id
        AND LEAST(delivered.sender_user_id,delivered.receiver_user_id)=original.user_low_id
        AND GREATEST(delivered.sender_user_id,delivered.receiver_user_id)=original.user_high_id));
