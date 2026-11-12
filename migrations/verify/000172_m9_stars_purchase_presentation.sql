DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND text_key IN(E'purchase.title',E'purchase.packages',E'purchase.package',E'purchase.nakh',E'purchase.terms_title',E'purchase.units',E'purchase.delivery',E'purchase.pending',E'purchase.correction',E'purchase.contact',E'purchase.rights',E'purchase.confirm',E'purchase.consent',E'purchase.cancel',E'purchase.back',E'purchase.cancelled',E'purchase.unavailable'))<>17 THEN RAISE EXCEPTION 'Stars purchase presentation incomplete'; END IF;
END $$;
