import { getSupabaseClient } from "./supabase-client.js";

export async function creerNotification(idUtilisateur, idHub, type, message, lien) {
  const { error } = await getSupabaseClient().rpc("rpc_creer_notification", {
    p_id_utilisateur: idUtilisateur || null, p_id_hub: idHub || null, p_type: type, p_message: message, p_lien: lien || null
  });
  return { ok: !error, message: error?.message };
}

export async function listerMesNotifications() {
  const { data, error } = await getSupabaseClient().rpc("rpc_lister_mes_notifications");
  if (error) throw error;
  return data || [];
}

export async function compterNotificationsNonLues() {
  const { data, error } = await getSupabaseClient().rpc("rpc_compter_notifications_non_lues");
  if (error) return 0;
  return data || 0;
}

export async function marquerNotificationLue(id) {
  await getSupabaseClient().rpc("rpc_marquer_notification_lue", { p_id: id });
}

export async function marquerToutesNotificationsLues() {
  await getSupabaseClient().rpc("rpc_marquer_toutes_notifications_lues");
}

// Piège connu de supabase-js : sur une réponse non-2xx d'une fonction Edge,
// error.message reste générique ("Edge Function returned a non-2xx status
// code") — le vrai message est dans error.context (l'objet Response brut),
// à parser soi-même.
async function extraireErreurFonction(error, data) {
  if (data?.error) return data.error;
  if (error?.context && typeof error.context.json === "function") {
    try {
      const corps = await error.context.json();
      if (corps?.error) return corps.error;
    } catch { /* corps non-JSON : on retombe sur error.message */ }
  }
  return error?.message || "Une erreur est survenue.";
}

// ---------------------------------------------------------------------------
// Lecture (vues uniquement — jamais de table métier directement)
// ---------------------------------------------------------------------------

export async function listerMesMissions(idLivreur) {
  const { data, error } = await getSupabaseClient()
    .from("v_missions_livreur")
    .select("*")
    .eq("id_livreur", idLivreur)
    .order("id_commande", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function lireMaPerformanceDuJour(idLivreur) {
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const { data, error } = await getSupabaseClient()
    .from("v_performance_livreur_jour")
    .select("nb_ramassages, nb_livraisons, ca_livre, marge_jour")
    .eq("id_livreur", idLivreur)
    .eq("jour", aujourdhui)
    .maybeSingle();
  if (error) throw error;
  return data || { nb_ramassages: 0, nb_livraisons: 0, ca_livre: 0, marge_jour: 0 };
}

export async function lireMaCaisse(idLivreur) {
  const { data, error } = await getSupabaseClient()
    .from("v_caisse_livreur")
    .select("solde_especes")
    .eq("id_livreur", idLivreur)
    .maybeSingle();
  if (error) throw error;
  return Number(data?.solde_especes || 0);
}

// ---------------------------------------------------------------------------
// Écriture (RPC exclusivement — chaque appel journalisé côté serveur)
// ---------------------------------------------------------------------------

export async function validerRamassage(idCommande, code) {
  const { error } = await getSupabaseClient().rpc("rpc_valider_ramassage", {
    p_id_commande: idCommande,
    p_code: code
  });
  return { ok: !error, message: error?.message };
}

export async function demanderDepot(idColis) {
  const { error } = await getSupabaseClient().rpc("avancer_colis", {
    p_id_colis: idColis,
    p_evenement: "DEMANDER_DEPOT"
  });
  return { ok: !error, message: error?.message };
}

export async function listerHubs() {
  const { data, error } = await getSupabaseClient().from("hubs").select("id_hub, nom, adresse").eq("actif", true).order("nom");
  if (error) throw error;
  return data || [];
}

export async function demanderDepotRetour(idColis, idHubReel, motif) {
  const { error } = await getSupabaseClient().rpc("avancer_colis", {
    p_id_colis: idColis,
    p_evenement: "DEMANDER_RETOUR_HUB",
    p_motif: motif || null,
    p_details: idHubReel ? { id_hub_reel: idHubReel } : {}
  });
  return { ok: !error, message: error?.message };
}

export async function demanderRecuperation(idColis) {
  const { error } = await getSupabaseClient().rpc("avancer_colis", {
    p_id_colis: idColis,
    p_evenement: "DEMANDER_RECUPERATION"
  });
  return { ok: !error, message: error?.message };
}

// Même principe que demanderRecuperation, mais côté retour (un livreur
// assigné à ramener un colis chez l'expéditeur doit confirmer être passé
// le récupérer au hub avant de l'avoir réellement en main).
export async function demanderRecuperationRetour(idColis) {
  const { error } = await getSupabaseClient().rpc("avancer_colis", {
    p_id_colis: idColis,
    p_evenement: "DEMANDER_RECUPERATION_RETOUR"
  });
  return { ok: !error, message: error?.message };
}

export async function encaisserEspecesRetour(idColis) {
  const { error } = await getSupabaseClient().rpc("rpc_encaisser_especes_retour", { p_id_colis: idColis });
  return { ok: !error, message: error?.message };
}

export async function encaisserEspeces(idColis) {
  const { error } = await getSupabaseClient().rpc("rpc_encaisser_especes", { p_id_colis: idColis });
  return { ok: !error, message: error?.message };
}

// Paiement PAR_EXPEDITEUR collecté au ramassage (avant : simple étiquette,
// jamais réellement facturé nulle part).
export async function encaisserEspecesRamassage(idColis) {
  const { error } = await getSupabaseClient().rpc("rpc_encaisser_especes_ramassage", { p_id_colis: idColis });
  return { ok: !error, message: error?.message };
}

export async function initierPaiementWave(idColis, type = "livraison") {
  const { data, error } = await getSupabaseClient().functions.invoke("wave-initier-paiement", {
    body: { id_colis: idColis, type }
  });
  if (error || data?.error) return { ok: false, message: await extraireErreurFonction(error, data) };
  return { ok: true, idPaiement: data.data.id_paiement, waveLaunchUrl: data.data.wave_launch_url };
}

// Paiement Wave expéditeur pour TOUTE la commande en un coup (plusieurs
// colis, un seul paiement) — contrairement au paiement livraison/retour,
// qui reste toujours colis par colis (chaque destinataire est distinct).
export async function initierPaiementWaveRamassageCommande(idCommande) {
  const { data, error } = await getSupabaseClient().functions.invoke("wave-initier-paiement", {
    body: { id_commande: idCommande, type: "ramassage_commande" }
  });
  if (error || data?.error) return { ok: false, message: await extraireErreurFonction(error, data) };
  return { ok: true, idPaiement: data.data.id_paiement, waveLaunchUrl: data.data.wave_launch_url };
}

// Sondage court après une initiation Wave : le webhook confirme en 2-10 secondes.
export async function attendreConfirmationWave(idPaiement, tentativesMax = 15) {
  const supabase = getSupabaseClient();
  for (let i = 0; i < tentativesMax; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const { data } = await supabase.from("paiements").select("statut").eq("id", idPaiement).maybeSingle();
    if (data?.statut === "PAYE") return true;
    if (data?.statut === "ECHOUE") return false;
  }
  return null; // toujours en attente : on laisse le livreur réessayer ou basculer en espèces
}

export async function validerLivraison(idColis, code) {
  const { error } = await getSupabaseClient().rpc("avancer_colis", {
    p_id_colis: idColis,
    p_evenement: "VALIDER_LIVRAISON",
    p_code: code
  });
  if (!error) {
    // Notification "à froid" : jamais bloquante, un souci de SMS ne doit
    // jamais remettre en cause une livraison déjà validée en base.
    getSupabaseClient().functions.invoke("notifier-sms", {
      body: { evenement: "COLIS_LIVRE", id_colis: idColis }
    }).catch(() => {});
  }
  return { ok: !error, message: error?.message };
}

export async function signalerEchec(idColis, motif) {
  const { error } = await getSupabaseClient().rpc("avancer_colis", {
    p_id_colis: idColis,
    p_evenement: "SIGNALER_ECHEC",
    p_motif: motif
  });
  return { ok: !error, message: error?.message };
}

export async function validerRemiseExpediteur(idColis, code) {
  const { error } = await getSupabaseClient().rpc("avancer_colis", {
    p_id_colis: idColis,
    p_evenement: "VALIDER_REMISE_EXPEDITEUR",
    p_code: code
  });
  return { ok: !error, message: error?.message };
}

export async function verserCaisse(montant) {
  const { error } = await getSupabaseClient().rpc("rpc_verser_caisse", { p_montant: montant });
  return { ok: !error, message: error?.message };
}
