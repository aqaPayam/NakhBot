DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.flow_reference_anchors'::regclass
      AND tgname='flow_reference_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.flow_reference_anchors'::regclass
      AND tgname='flow_reference_committed' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakh_flows'::regclass
      AND tgname='flow_original_reference_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakh_flows'::regclass
      AND tgname='flow_original_reference' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakh_flows'::regclass
      AND tgname='a_flow_original_identity_guard' AND tgenabled='O')
    OR EXISTS(SELECT 1 FROM nakh.nakh_flows flow WHERE NOT nakh.original_flow_reference_valid(flow.id))
    OR EXISTS(SELECT 1 FROM nakh.flow_reference_anchors anchor WHERE NOT nakh.original_flow_reference_valid(anchor.id)) THEN
    RAISE EXCEPTION 'original Flow reference safeguards missing';
  END IF;
END $$;
