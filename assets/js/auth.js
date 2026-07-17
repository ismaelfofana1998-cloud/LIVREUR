import { getSupabaseClient, getSessionActuelle } from "./supabase-client.js";

// L'invariant du schéma V3 : id_utilisateur = auth.users.id, toujours.
export async function chargerProfilLivreur() {
  const session = await getSessionActuelle();
  if (!session?.user) return null;

  const { data, error } = await getSupabaseClient()
    .from("utilisateurs")
    .select("id_utilisateur, id_entreprise, nom, role, actif, id_vehicule, id_hub_affecte")
    .eq("id_utilisateur", session.user.id)
    .maybeSingle();

  if (error || !data) return null;
  if (data.role !== "livreur" || !data.actif) return null;
  return data;
}

export async function connecterLivreur(email, password) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data?.session) {
    // On distingue un vrai refus d'identifiants d'un souci technique (config manquante,
    // réseau, projet Supabase injoignable) : sinon une erreur de configuration ressemble
    // à un mot de passe faux et est très difficile à diagnostiquer.
    if (error?.message === "Invalid login credentials") {
      return { ok: false, message: "Email ou mot de passe incorrect." };
    }
    return { ok: false, message: error?.message || "Connexion impossible. Vérifie ta connexion internet et réessaie." };
  }
  const profil = await chargerProfilLivreur();
  if (!profil) {
    await supabase.auth.signOut();
    return { ok: false, message: "Ce compte n'est pas un compte livreur actif." };
  }
  return { ok: true, profil };
}

export async function deconnecterLivreur() {
  await getSupabaseClient().auth.signOut();
  window.location.href = "./index.html";
}

// Garde de page : à appeler en haut de app.html. Redirige si non éligible.
export async function garantirAccesLivreur() {
  const profil = await chargerProfilLivreur();
  if (!profil) {
    window.location.href = "./index.html";
    return null;
  }
  return profil;
}
