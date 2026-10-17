WITH seed(text_key,body) AS (VALUES
 ('admin.auth.open','Administrator sign-in'),
 ('admin.auth.title','Sign in as an administrator'),
 ('admin.auth.instructions','Open this page from your private bot menu. Use your authenticator app. Enrollment also requires a separate operator invitation.'),
 ('admin.auth.invitation','Operator invitation'),
 ('admin.auth.begin','Set up authenticator'),
 ('admin.auth.seed','Manual authenticator setup key'),
 ('admin.auth.code','Six-digit authenticator code'),
 ('admin.auth.confirm','Confirm enrollment'),
 ('admin.auth.signin','Sign in'),
 ('admin.auth.activated','Enrollment is complete. Wait for the next authenticator code, then sign in.'),
 ('admin.auth.signed_in','Signed in. Return to the bot and send /admin_reports, /admin_support or /admin_appeals.'),
 ('admin.auth.signed_out','You are signed out.'),
 ('admin.auth.signout','Sign out'),
 ('admin.auth.unavailable','Unable to complete this action. Use a current authenticator code, or open a new sign-in link from the bot.'),
 ('admin.auth.expired','This sign-in link is no longer current. Return to the bot for a new one.')
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,'admin','[]'::jsonb,true,clock_timestamp(),clock_timestamp() FROM seed;
