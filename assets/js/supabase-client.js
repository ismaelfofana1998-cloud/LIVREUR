import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

let client = null;
let sessionCache = null;

export function getSupabaseClient() {
  if (!client) {
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG || {};
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    client.auth.onAuthStateChange((_event, session) => {
      sessionCache = session;
    });
  }
  return client;
}

export async function getSessionActuelle() {
  if (sessionCache) return sessionCache;
  const { data } = await getSupabaseClient().auth.getSession();
  sessionCache = data?.session || null;
  return sessionCache;
}
