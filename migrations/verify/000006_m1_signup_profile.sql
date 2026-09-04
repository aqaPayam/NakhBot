DO $$
BEGIN
  IF to_regclass('identity.signup_progress') IS NULL
    OR to_regclass('identity.signup_drafts') IS NULL
    OR to_regclass('profile.profiles') IS NULL
    OR to_regclass('profile.profile_optional_details') IS NULL
    OR to_regclass('profile.profile_interests') IS NULL
    OR to_regclass('profile.profile_languages') IS NULL
    OR to_regclass('profile.profile_personality_tags') IS NULL THEN
    RAISE EXCEPTION 'M1 signup/Profile tables are missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'profiles_invariants' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'Profile hierarchy/ever-completed invariant trigger is missing';
  END IF;
END
$$;
