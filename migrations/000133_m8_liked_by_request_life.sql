-- Existing requests predate enabled Return. Never infer their original life from
-- current ownership after a return, nor admit unresolved legacy owners.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM channel_telegram.liked_by_delivery_requests request
    LEFT JOIN identity.accounts account ON account.user_id=request.viewer_user_id
    WHERE account.user_id IS NULL OR account.product_epoch<>0) THEN
    RAISE EXCEPTION 'legacy Liked By request requires original life provenance' USING ERRCODE='55000';
  END IF;
END $$;

ALTER TABLE channel_telegram.liked_by_delivery_requests
  ADD COLUMN product_epoch integer NOT NULL DEFAULT 0 CHECK(product_epoch>=0);

CREATE FUNCTION channel_telegram.guard_liked_by_request_life() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account identity.accounts;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.viewer_user_id<>OLD.viewer_user_id OR NEW.product_epoch<>OLD.product_epoch THEN
      RAISE EXCEPTION 'original Liked By request life is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM id FROM identity.users WHERE id=NEW.viewer_user_id FOR NO KEY UPDATE;
  SELECT * INTO account FROM identity.accounts WHERE user_id=NEW.viewer_user_id FOR UPDATE;
  IF account.user_id IS NULL OR account.state='deleted' OR account.product_epoch<>NEW.product_epoch THEN
    RAISE EXCEPTION 'Liked By request lacks original live account' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER liked_by_request_life_guard BEFORE INSERT OR UPDATE
  ON channel_telegram.liked_by_delivery_requests FOR EACH ROW
  EXECUTE FUNCTION channel_telegram.guard_liked_by_request_life();

COMMENT ON COLUMN channel_telegram.liked_by_delivery_requests.product_epoch IS
  'Verified original account life captured before asynchronous ingress; immutable through claim, retry and delivery.';
