-- The existing candidate-delivery producer emits reason=preview. Accept only
-- that exact content-free shape; do not widen the generic machine-value list.
DO $migration$ DECLARE definition text; marker text :=
  'definition:=platform.deletion_event_policy()->''shapes''->event_type;';
BEGIN
 SELECT pg_get_functiondef('platform.deletion_event_disposition(text,integer,jsonb)'::regprocedure)
 INTO definition;
 IF position(marker IN definition)=0 THEN
  RAISE EXCEPTION 'deletion event classifier shape changed' USING ERRCODE='55000';
 END IF;
 definition:=replace(definition,marker,$replacement$
  IF event_type='discovery.consumption-created.v1' AND payload->>'reason'='preview' THEN
    IF payload?&ARRAY['viewerUserId','targetUserId','reason']
      AND (SELECT count(*) FROM jsonb_object_keys(payload))=3
      AND platform.deletion_event_field_minimal('viewerUserId',payload->'viewerUserId') IS TRUE
      AND platform.deletion_event_field_minimal('targetUserId',payload->'targetUserId') IS TRUE
    THEN RETURN 'product_transport'; END IF;
    RETURN 'unclassified';
  END IF;
  definition:=platform.deletion_event_policy()->'shapes'->event_type;
 $replacement$);
 EXECUTE definition;
END $migration$;
