DO $$ BEGIN
  IF to_regclass('support.deletion_thread_closures') IS NULL
    OR to_regprocedure('support.deletion_thread_has_bound_closure(uuid,integer)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='support.support_threads'::regclass AND attname='product_epoch' AND attnotnull AND NOT attisdropped)
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='support.support_threads'::regclass AND conname='support_thread_original_epoch_unique')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='support.support_threads'::regclass AND tgname='support_thread_epoch_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='support.support_messages'::regclass AND tgname='support_message_epoch_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='support.support_threads'::regclass AND tgname='support_thread_epoch_commit_guard' AND tgdeferrable AND tginitdeferred AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='support.support_messages'::regclass AND tgname='support_message_epoch_commit_guard' AND tgdeferrable AND tginitdeferred AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='support.deletion_thread_closures'::regclass AND tgname='deletion_thread_closure_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='support.deletion_thread_closures'::regclass AND tgname='deletion_thread_closure_commit_guard' AND tgdeferrable AND tginitdeferred AND tgenabled='O') THEN
    RAISE EXCEPTION 'M8 retained support scope authority is incomplete';
  END IF;
END $$;
