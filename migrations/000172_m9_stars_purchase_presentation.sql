-- Reviewed purchase presentation. This does not enable invoices or approve prices.
WITH seed(text_key,body,variables) AS (VALUES
 (E'purchase.title',E'Review purchase',E'[]'::jsonb),
 (E'purchase.packages',E'Buy credits',E'[]'::jsonb),
 (E'purchase.package',E'{credits} credits for {stars} Telegram Stars',E'["credits", "stars"]'::jsonb),
 (E'purchase.nakh',E'One Nakh for {stars} Telegram Stars',E'["stars"]'::jsonb),
 (E'purchase.terms_title',E'Nakh purchase terms ({version})',E'["version"]'::jsonb),
 (E'purchase.units',E'Credits are internal Nakh product units, not money, cryptocurrency or a withdrawable balance.',E'[]'::jsonb),
 (E'purchase.delivery',E'The full price is shown in Telegram Stars. Value is delivered only after Telegram confirms payment. Approving this screen alone does not charge you.',E'[]'::jsonb),
 (E'purchase.pending',E'Pending Nakhes you already authorized may spend newly added credits automatically.',E'[]'::jsonb),
 (E'purchase.correction',E'If a verified system fault prevents delivery, we will correct the purchase or refund the affected Stars payment. Contact support about any missing or disputed purchase.',E'[]'::jsonb),
 (E'purchase.contact',E'Purchase and refund support: @{support} (https://t.me/{support}). Telegram support cannot resolve purchases from this bot.',E'["support"]'::jsonb),
 (E'purchase.rights',E'These terms do not limit any rights you have under applicable law.',E'[]'::jsonb),
 (E'purchase.confirm',E'I agree: open Telegram payment',E'[]'::jsonb),
 (E'purchase.consent',E'By choosing the confirmation button, you confirm that you have read and agree to these purchase terms and the exact offer above.',E'[]'::jsonb),
 (E'purchase.cancel',E'Cancel purchase',E'[]'::jsonb),
 (E'purchase.back',E'Back to credits',E'[]'::jsonb),
 (E'purchase.cancelled',E'Purchase cancelled. No new invoice was requested.',E'[]'::jsonb),
 (E'purchase.unavailable',E'This purchase is no longer available. Open your credits menu again. For an existing payment, use /paysupport.',E'[]'::jsonb)
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT gen_random_uuid(),'en',text_key,body,'payment',variables,true,clock_timestamp(),clock_timestamp() FROM seed;
