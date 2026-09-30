DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'moderation.evidence_access_audits'::regclass
      AND conname = 'evidence_access_audits_admin_command_uq'
      AND pg_get_constraintdef(oid) = 'UNIQUE (admin_user_id, command_id)'
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'moderation.evidence_access_audits'::regclass
      AND conname = 'evidence_access_audits_command_id_key'
  ) THEN
    RAISE EXCEPTION 'evidence access command identity must be admin-bound';
  END IF;
END $$;
