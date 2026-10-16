DO $$ DECLARE payload jsonb := jsonb_build_object(
 'viewerUserId','10000000-0000-4000-8000-000000000001',
 'targetUserId','10000000-0000-4000-8000-000000000002','reason','preview');
BEGIN
 IF platform.deletion_event_disposition('discovery.consumption-created.v1',1,payload)<>'product_transport'
  OR platform.deletion_event_disposition('discovery.consumption-created.v1',2,payload)<>'unclassified'
  OR platform.deletion_event_disposition('discovery.consumption-created.v1',1,payload||'{"text":"private"}'::jsonb)<>'unclassified'
  OR platform.deletion_event_disposition('discovery.consumption-created.v1',1,payload- 'targetUserId')<>'unclassified'
  OR platform.deletion_event_disposition('discovery.consumption-created.v1',1,payload||'{"viewerUserId":"invalid"}'::jsonb)<>'unclassified'
  OR platform.deletion_event_disposition('unknown.event.v1',1,payload)<>'unclassified'
  OR platform.deletion_event_field_minimal('reason','"preview"'::jsonb) IS NOT FALSE THEN
  RAISE EXCEPTION 'preview consumption disposition is incomplete';
 END IF;
END $$;
