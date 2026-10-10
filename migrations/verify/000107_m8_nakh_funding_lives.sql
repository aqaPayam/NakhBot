DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM nakh.nakhes source WHERE NOT nakh.original_funding_life_valid(source))
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakhes'::regclass
      AND tgname='nakh_original_funding_life_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='nakh.nakhes'::regclass AND tgname='nakhes_funding_guard' AND tgenabled='O') THEN
    RAISE EXCEPTION 'original Nakh funding life safeguards missing';
  END IF;
END $$;
