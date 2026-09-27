CREATE TABLE moderation.report_evidence (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES moderation.reports(id) ON DELETE RESTRICT,
  evidence_type text NOT NULL CHECK (evidence_type IN (
    'profile','photo','chat','message','unmatched_user'
  )),
  profile_id uuid REFERENCES profile.profiles(id) ON DELETE RESTRICT,
  profile_photo_id uuid REFERENCES media.profile_photos(id) ON DELETE RESTRICT,
  chat_session_id uuid REFERENCES chat.chat_sessions(id) ON DELETE RESTRICT,
  chat_message_id uuid,
  unmatch_record_id uuid REFERENCES matching.unmatch_records(match_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT report_evidence_typed_reference_ck CHECK (
    (evidence_type = 'profile' AND profile_id IS NOT NULL
      AND profile_photo_id IS NULL AND chat_session_id IS NULL
      AND chat_message_id IS NULL AND unmatch_record_id IS NULL)
    OR (evidence_type = 'photo' AND profile_id IS NULL
      AND profile_photo_id IS NOT NULL AND chat_session_id IS NULL
      AND chat_message_id IS NULL AND unmatch_record_id IS NULL)
    OR (evidence_type = 'chat' AND profile_id IS NULL
      AND profile_photo_id IS NULL AND chat_session_id IS NOT NULL
      AND chat_message_id IS NULL AND unmatch_record_id IS NULL)
    OR (evidence_type = 'message' AND profile_id IS NULL
      AND profile_photo_id IS NULL AND chat_session_id IS NULL
      AND chat_message_id IS NOT NULL AND unmatch_record_id IS NULL)
    OR (evidence_type = 'unmatched_user' AND profile_id IS NULL
      AND profile_photo_id IS NULL AND chat_session_id IS NULL
      AND chat_message_id IS NULL AND unmatch_record_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX report_evidence_profile_uq
  ON moderation.report_evidence (report_id, profile_id) WHERE evidence_type = 'profile';
CREATE UNIQUE INDEX report_evidence_photo_uq
  ON moderation.report_evidence (report_id, profile_photo_id) WHERE evidence_type = 'photo';
CREATE UNIQUE INDEX report_evidence_chat_uq
  ON moderation.report_evidence (report_id, chat_session_id) WHERE evidence_type = 'chat';
CREATE UNIQUE INDEX report_evidence_message_uq
  ON moderation.report_evidence (report_id, chat_message_id) WHERE evidence_type = 'message';
CREATE UNIQUE INDEX report_evidence_unmatch_uq
  ON moderation.report_evidence (report_id, unmatch_record_id)
  WHERE evidence_type = 'unmatched_user';
CREATE INDEX report_evidence_report_idx
  ON moderation.report_evidence (report_id, evidence_type, id);

CREATE FUNCTION moderation.validate_report_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  report_row moderation.reports%ROWTYPE;
  related boolean;
BEGIN
  SELECT * INTO report_row FROM moderation.reports WHERE id = NEW.report_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report evidence has no governing report' USING ERRCODE = '23503';
  END IF;

  IF NEW.evidence_type IN ('profile','photo') THEN
    related := EXISTS (
      SELECT 1 FROM discovery.candidate_deliveries delivery
      WHERE delivery.viewer_user_id = report_row.reporter_user_id
        AND delivery.target_user_id = report_row.target_user_id
        AND delivery.state = 'delivered'
    ) OR EXISTS (
      SELECT 1 FROM matching.matches match
      WHERE report_row.reporter_user_id IN (match.user_low_id, match.user_high_id)
        AND report_row.target_user_id IN (match.user_low_id, match.user_high_id)
    ) OR EXISTS (
      SELECT 1 FROM nakh.nakhes nakh
      WHERE nakh.receiver_user_id = report_row.reporter_user_id
        AND nakh.sender_user_id = report_row.target_user_id
    ) OR EXISTS (
      SELECT 1 FROM interaction.likes like_row
      WHERE like_row.receiver_user_id = report_row.reporter_user_id
        AND like_row.sender_user_id = report_row.target_user_id
    );
    IF NOT related OR (
      NEW.evidence_type = 'profile' AND NOT EXISTS (
        SELECT 1 FROM profile.profiles profile
        WHERE profile.id = NEW.profile_id AND profile.user_id = report_row.target_user_id
      )
    ) OR (
      NEW.evidence_type = 'photo' AND NOT EXISTS (
        SELECT 1 FROM media.profile_photos photo
        JOIN profile.profiles profile ON profile.id = photo.profile_id
        WHERE photo.id = NEW.profile_photo_id AND profile.user_id = report_row.target_user_id
      )
    ) THEN
      RAISE EXCEPTION 'profile or photo evidence is not authorized' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.evidence_type = 'chat' THEN
    IF NOT EXISTS (
      SELECT 1 FROM chat.chat_sessions session
      JOIN matching.matches match ON match.id = session.match_id
      WHERE session.id = NEW.chat_session_id
        AND report_row.reporter_user_id IN (match.user_low_id, match.user_high_id)
        AND report_row.target_user_id IN (match.user_low_id, match.user_high_id)
    ) THEN
      RAISE EXCEPTION 'chat evidence is not authorized' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.evidence_type = 'message' THEN
    IF NOT EXISTS (
      SELECT 1 FROM chat.chat_messages message
      JOIN chat.chat_sessions session ON session.id = message.chat_session_id
      JOIN matching.matches match ON match.id = session.match_id
      WHERE message.id = NEW.chat_message_id
        AND report_row.reporter_user_id IN (match.user_low_id, match.user_high_id)
        AND report_row.target_user_id IN (match.user_low_id, match.user_high_id)
    ) THEN
      RAISE EXCEPTION 'message evidence is not authorized' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.evidence_type = 'unmatched_user' THEN
    IF NOT EXISTS (
      SELECT 1 FROM matching.unmatch_records unmatch
      JOIN matching.matches match ON match.id = unmatch.match_id
      WHERE unmatch.match_id = NEW.unmatch_record_id
        AND report_row.reporter_user_id IN (match.user_low_id, match.user_high_id)
        AND report_row.target_user_id IN (match.user_low_id, match.user_high_id)
        AND transaction_timestamp() < unmatch.report_window_expires_at
    ) THEN
      RAISE EXCEPTION 'unmatched user evidence is not authorized or its window expired'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER report_evidence_valid
BEFORE INSERT ON moderation.report_evidence
FOR EACH ROW EXECUTE FUNCTION moderation.validate_report_evidence();

CREATE FUNCTION moderation.reject_report_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'report evidence is immutable' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER report_evidence_immutable
BEFORE UPDATE OR DELETE ON moderation.report_evidence
FOR EACH ROW EXECUTE FUNCTION moderation.reject_report_evidence_mutation();

CREATE FUNCTION moderation.require_report_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM moderation.report_evidence WHERE report_id = NEW.id) THEN
    RAISE EXCEPTION 'report must contain authorized evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER report_requires_evidence
AFTER INSERT OR UPDATE ON moderation.reports
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION moderation.require_report_evidence();

CREATE TABLE moderation.report_snapshots (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES moderation.reports(id) ON DELETE RESTRICT,
  report_evidence_id uuid NOT NULL UNIQUE REFERENCES moderation.report_evidence(id) ON DELETE RESTRICT,
  snapshot_type text NOT NULL CHECK (snapshot_type IN (
    'profile','photo','chat','unmatched_user'
  )),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  encryption_key_id text NOT NULL CHECK (char_length(encryption_key_id) BETWEEN 8 AND 160),
  encryption_key_version integer NOT NULL CHECK (encryption_key_version >= 1),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 65536),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX report_snapshots_report_created_idx
  ON moderation.report_snapshots (report_id, created_at, id);
CREATE INDEX report_snapshots_key_version_idx
  ON moderation.report_snapshots (encryption_key_id, encryption_key_version, created_at, id);

CREATE FUNCTION moderation.validate_report_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM moderation.report_evidence evidence
    WHERE evidence.id = NEW.report_evidence_id
      AND evidence.report_id = NEW.report_id
      AND evidence.evidence_type = NEW.snapshot_type
  ) THEN
    RAISE EXCEPTION 'report snapshot does not match its evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER report_snapshot_valid
BEFORE INSERT ON moderation.report_snapshots
FOR EACH ROW EXECUTE FUNCTION moderation.validate_report_snapshot();

CREATE FUNCTION moderation.reject_report_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'report snapshots are immutable' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER report_snapshots_immutable
BEFORE UPDATE OR DELETE ON moderation.report_snapshots
FOR EACH ROW EXECUTE FUNCTION moderation.reject_report_snapshot_mutation();

CREATE TABLE moderation.evidence_access_audits (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES moderation.reports(id) ON DELETE RESTRICT,
  report_evidence_id uuid NOT NULL REFERENCES moderation.report_evidence(id) ON DELETE RESTRICT,
  admin_user_id uuid NOT NULL REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  request_id uuid NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  accessed_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX evidence_access_audits_report_time_idx
  ON moderation.evidence_access_audits (report_id, accessed_at DESC, id DESC);
CREATE INDEX evidence_access_audits_admin_time_idx
  ON moderation.evidence_access_audits (admin_user_id, accessed_at DESC, id DESC);

CREATE FUNCTION moderation.validate_evidence_access_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM moderation.report_evidence
    WHERE id = NEW.report_evidence_id AND report_id = NEW.report_id
  ) THEN
    RAISE EXCEPTION 'evidence access audit does not match its report' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER evidence_access_audit_valid
BEFORE INSERT ON moderation.evidence_access_audits
FOR EACH ROW EXECUTE FUNCTION moderation.validate_evidence_access_audit();

CREATE TRIGGER evidence_access_audits_immutable
BEFORE UPDATE OR DELETE ON moderation.evidence_access_audits
FOR EACH ROW EXECUTE FUNCTION moderation.reject_report_snapshot_mutation();

ALTER TABLE chat.chat_message_snapshot_requests
  ADD CONSTRAINT chat_snapshot_requests_report_fk
  FOREIGN KEY (report_id) REFERENCES moderation.reports(id) ON DELETE RESTRICT;
ALTER TABLE chat.chat_message_snapshots
  ADD CONSTRAINT chat_message_snapshots_report_fk
  FOREIGN KEY (report_id) REFERENCES moderation.reports(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION chat.validate_snapshot_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM chat.chat_messages
    WHERE id = NEW.original_message_id AND chat_session_id = NEW.chat_session_id
  ) OR NOT EXISTS (
    SELECT 1 FROM moderation.report_evidence
    WHERE report_id = NEW.report_id AND evidence_type = 'message'
      AND chat_message_id = NEW.original_message_id
  ) THEN
    RAISE EXCEPTION 'snapshot request must reference authorized live message evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION chat.validate_message_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source chat.chat_messages%ROWTYPE;
  expected_content jsonb;
BEGIN
  SELECT * INTO source FROM chat.chat_messages
  WHERE id = NEW.original_message_id AND chat_session_id = NEW.chat_session_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM chat.chat_message_snapshot_requests
    WHERE report_id = NEW.report_id AND original_message_id = NEW.original_message_id
      AND chat_session_id = NEW.chat_session_id
  ) OR NOT EXISTS (
    SELECT 1 FROM moderation.report_evidence
    WHERE report_id = NEW.report_id AND evidence_type = 'message'
      AND chat_message_id = NEW.original_message_id
  ) THEN
    RAISE EXCEPTION 'snapshot source, request, or report evidence is missing'
      USING ERRCODE = '23514';
  END IF;
  expected_content := CASE source.message_type
    WHEN 'predefined_question' THEN jsonb_build_object(
      'predefinedQuestionId', source.predefined_question_id
    )
    WHEN 'predefined_answer' THEN jsonb_build_object(
      'predefinedAnswerId', source.predefined_answer_id
    )
    WHEN 'text' THEN jsonb_build_object('text', source.text)
    WHEN 'system' THEN jsonb_build_object(
      'localizationKey', source.text, 'arguments', source.system_arguments
    )
  END;
  IF NEW.sender_user_id IS DISTINCT FROM source.sender_user_id
    OR NEW.message_type <> source.message_type
    OR NEW.original_created_at <> source.created_at
    OR NEW.content <> expected_content THEN
    RAISE EXCEPTION 'snapshot does not match its live source' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION moderation.guard_message_evidence_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM moderation.report_evidence evidence
    WHERE evidence.evidence_type = 'message' AND evidence.chat_message_id = OLD.id
      AND NOT EXISTS (
        SELECT 1 FROM chat.chat_message_snapshots snapshot
        WHERE snapshot.report_id = evidence.report_id
          AND snapshot.original_message_id = evidence.chat_message_id
      )
  ) THEN
    RAISE EXCEPTION 'message evidence must be snapshotted before live deletion'
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER chat_message_evidence_delete_guard
BEFORE DELETE ON chat.chat_messages
FOR EACH ROW EXECUTE FUNCTION moderation.guard_message_evidence_delete();

ALTER TABLE media.photo_moderation_records
  DROP CONSTRAINT media_report_not_yet_available;
ALTER TABLE media.photo_moderation_records
  ADD CONSTRAINT photo_moderation_report_fk
  FOREIGN KEY (report_id) REFERENCES moderation.reports(id) ON DELETE RESTRICT;

COMMENT ON TABLE moderation.report_evidence IS
  'Immutable typed evidence references authorized against the governing report participants.';
COMMENT ON TABLE moderation.report_snapshots IS
  'Encrypted, versioned, integrity-bound immutable snapshots; plaintext is never stored.';
COMMENT ON TABLE moderation.evidence_access_audits IS
  'Append-only target-scoped audit of authorized evidence reveals without decrypted content.';
COMMENT ON TABLE chat.chat_message_snapshots IS
  'Append-only restricted Report evidence, owned by the M7 governing Report foreign key.';
