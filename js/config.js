// Where the shared schedule lives. Both values are meant to be public: the database
// only answers to signed-in accounts that are on its editor list (supabase/setup.sql).
// Never put a secret or service_role key in this file.
export const SUPABASE_URL = 'https://rmcrmcxvcispnfozcrfc.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_6pAn13CWVQE_4vfQZ6CaHA_o84ok5eq';
// Signing in with a plain username "name" means the account name@USERNAME_DOMAIN.
export const USERNAME_DOMAIN = 'branchschedule.github.io';
