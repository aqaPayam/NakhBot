-- Keep the exact metadata predicate synchronized even when privileged recovery bypasses triggers.
-- This is capture shape only, not cryptographic authentication of the retained bytes.
ALTER TABLE moderation.report_snapshots ADD COLUMN metadata_shape_valid boolean
  GENERATED ALWAYS AS (
    schema_version = 1 AND encryption_key_version >= 1
    AND octet_length(nonce) = 12 AND octet_length(ciphertext) BETWEEN 17 AND 65536
    AND content_sha256 ~ '^[0-9a-f]{64}$'
  ) STORED NOT NULL;
