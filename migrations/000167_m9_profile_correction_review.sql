-- Permission-checked administrator correction review presentation. Existing queue index is reused.
WITH seed(text_key,body,variables) AS (VALUES
 (E'profile.review.approve',E'Approve correction','[]'::jsonb),
 (E'profile.review.back',E'Back to corrections','[]'::jsonb),
 (E'profile.review.body',E'{field}\nCurrent: {old}\nRequested: {requested}\nReason: {reason}\nStatus: {status}','["field","old","reason","requested","status"]'::jsonb),
 (E'profile.review.cancel',E'Cancel','[]'::jsonb),
 (E'profile.review.confirm',E'Confirm review','[]'::jsonb),
 (E'profile.review.confirm_approve',E'Approve this correction and change the protected profile field?','[]'::jsonb),
 (E'profile.review.confirm_reject',E'Reject this correction request?','[]'::jsonb),
 (E'profile.review.empty',E'No pending profile corrections.','[]'::jsonb),
 (E'profile.review.open',E'Open this correction request? Viewing its contents is audited.','[]'::jsonb),
 (E'profile.review.processed',E'This action has already been processed. Open /admin_changes for a fresh menu.','[]'::jsonb),
 (E'profile.review.reject',E'Reject correction','[]'::jsonb),
 (E'profile.review.row',E'{field} · {submitted}','["field","submitted"]'::jsonb),
 (E'profile.review.saved',E'Review saved.','[]'::jsonb),
 (E'profile.review.title',E'Profile corrections','[]'::jsonb),
 (E'profile.review.unavailable',E'This administrator action is unavailable. Sign in again or open /admin_changes for a current menu.','[]'::jsonb),
 (E'profile.review.view',E'View request','[]'::jsonb)
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,'message',variables,true,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM seed;
UPDATE catalog.ui_texts SET value=E'Signed in. Return to the bot and send /admin_reports, /admin_support, /admin_appeals or /admin_changes.',updated_at='2026-01-01T00:00:00Z' WHERE locale_code='en' AND text_key=E'admin.auth.signed_in';
UPDATE catalog.ui_texts SET value=E'Changes save as you tap. Keep five to twenty interests. Add one before removing if only five are selected; remove one before adding if twenty are selected.',updated_at='2026-01-01T00:00:00Z' WHERE locale_code='en' AND text_key=E'profile.edit.multi';
