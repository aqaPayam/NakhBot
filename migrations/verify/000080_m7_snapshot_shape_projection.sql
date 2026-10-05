DO $$
DECLARE actual_expression text; expected_expression text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='moderation.report_snapshots'::regclass
    AND attname='metadata_shape_valid' AND NOT attisdropped AND attnotnull
    AND atttypid='boolean'::regtype AND attgenerated='s') THEN
    RAISE EXCEPTION 'stored snapshot shape projection is incomplete';
  END IF;
  -- Let PostgreSQL canonicalize both expressions, rather than guessing deparser parentheses.
  CREATE TEMP TABLE m7_snapshot_shape_verification (
    schema_version integer, encryption_key_version integer, nonce bytea, ciphertext bytea,
    content_sha256 text, metadata_shape_valid boolean GENERATED ALWAYS AS (
      schema_version = 1 AND encryption_key_version >= 1
      AND octet_length(nonce) = 12 AND octet_length(ciphertext) BETWEEN 17 AND 65536
      AND content_sha256 ~ '^[0-9a-f]{64}$'
    ) STORED
  ) ON COMMIT DROP;
  SELECT pg_get_expr(def.adbin,def.adrelid) INTO actual_expression FROM pg_attrdef def
    JOIN pg_attribute attribute ON attribute.attrelid=def.adrelid AND attribute.attnum=def.adnum
    WHERE def.adrelid='moderation.report_snapshots'::regclass AND attribute.attname='metadata_shape_valid';
  SELECT pg_get_expr(def.adbin,def.adrelid) INTO expected_expression FROM pg_attrdef def
    JOIN pg_attribute attribute ON attribute.attrelid=def.adrelid AND attribute.attnum=def.adnum
    WHERE def.adrelid='pg_temp.m7_snapshot_shape_verification'::regclass AND attribute.attname='metadata_shape_valid';
  IF actual_expression IS DISTINCT FROM expected_expression THEN
    RAISE EXCEPTION 'stored snapshot shape expression differs from its authoritative predicate';
  END IF;
END $$;
