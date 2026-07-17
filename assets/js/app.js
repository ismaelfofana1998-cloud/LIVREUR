import { garantirAccesLivreur, deconnecterLivreur } from "./auth.js";
import {
  listerMesMissions, lireMaPerformanceDuJour, lireMaCaisse,
  validerRamassage, demanderDepot, demanderDepotRetour, demanderRecuperation,
  demanderRecuperationRetour, encaisserEspeces, encaisserEspecesRetour, encaisserEspecesRamassage,
  initierPaiementWave, initierPaiementWaveRamassageCommande, attendreConfirmationWave,
  validerLivraison, signalerEchec, validerRemiseExpediteur, verserCaisse, listerHubs,
  creerNotification, listerMesNotifications, compterNotificationsNonLues, marquerNotificationLue, marquerToutesNotificationsLues
} from "./repository.js";

const MOTIFS = [
  { code: "DESTINATAIRE_ABSENT", libelle: "Destinataire absent" },
  { code: "INJOIGNABLE", libelle: "Injoignable au téléphone" },
  { code: "ADRESSE_INTROUVABLE", libelle: "Adresse introuvable" },
  { code: "ANNULATION_CLIENT", libelle: "Client a annulé" },
  { code: "REFUS_COLIS", libelle: "Refus du colis" },
  { code: "AUTRE", libelle: "Autre motif" }
];

let profil = null;
let missions = [];
let hubsDisponibles = [];
// Persistance de l'onglet actif entre deux rechargements de page : sans ça,
// on retombe toujours sur "À ramasser" après un refresh, ce qui est
// désorientant en plein milieu d'une tournée.
let ongletActif = sessionStorage.getItem("ikigai_onglet_actif") || "A_RAMASSER";
let enChargement = false;

const elContenu = document.querySelector("#contenu");
const elBoutonsOnglet = document.querySelectorAll(".onglet");

function formaterFcfa(montant) {
  return new Intl.NumberFormat("fr-FR").format(Math.round(Number(montant) || 0));
}

function afficherFlash(texte) {
  const el = document.createElement("div");
  el.className = "message-succes-flash";
  el.textContent = texte;
  document.body.append(el);
  setTimeout(() => el.remove(), 2400);
}

function fermerVoile() {
  document.querySelector(".voile")?.remove();
}

function ouvrirVoile(contenuHtml, apresMontage) {
  fermerVoile();
  const voile = document.createElement("div");
  voile.className = "voile";
  voile.innerHTML = `<div class="feuille"><div class="feuille-poignee"></div>${contenuHtml}</div>`;
  voile.addEventListener("click", (e) => { if (e.target === voile) fermerVoile(); });
  document.body.append(voile);
  apresMontage?.(voile);
  return voile;
}

// ---------------------------------------------------------------------------
// Chargement des données
// ---------------------------------------------------------------------------

async function rafraichir({ silencieux = false } = {}) {
  if (enChargement) return;
  enChargement = true;
  try {
    const [mesMissions, performance, caisse] = await Promise.all([
      listerMesMissions(profil.id_utilisateur),
      lireMaPerformanceDuJour(profil.id_utilisateur),
      lireMaCaisse(profil.id_utilisateur)
    ]);
    missions = mesMissions;
    document.querySelector("#cpt-ramassages").textContent = performance.nb_ramassages;
    document.querySelector("#cpt-livraisons").textContent = performance.nb_livraisons;
    document.querySelector("#cpt-gains").textContent = formaterFcfa(performance.ca_livre);
    window.__soldeCaisse = caisse;
    rendreOnglets();
    rendreContenu();
  } catch (err) {
    if (!silencieux) elContenu.innerHTML = `<div class="etat-vide"><p>Connexion instable. Tire vers le bas ou réessaie dans un instant.</p></div>`;
  } finally {
    enChargement = false;
  }
}

function rendreOnglets() {
  const compte = { A_RAMASSER: new Set(), A_DEPOSER: 0, AU_HUB: 0, A_LIVRER: 0, RETOURS: 0 };
  missions.forEach((m) => {
    if (m.onglet === "A_RAMASSER") compte.A_RAMASSER.add(m.id_commande);
    else if (m.onglet in compte) compte[m.onglet]++;
  });
  majBadge("badge-ramasser", compte.A_RAMASSER.size);
  majBadge("badge-deposer", compte.A_DEPOSER);
  majBadge("badge-hub", compte.AU_HUB);
  majBadge("badge-livrer", compte.A_LIVRER);
  majBadge("badge-retours", compte.RETOURS);
}

function majBadge(id, valeur) {
  const el = document.querySelector(`#${id}`);
  el.hidden = valeur === 0;
  el.textContent = valeur > 99 ? "99+" : valeur;
}

// ---------------------------------------------------------------------------
// Rendu du contenu par onglet
// ---------------------------------------------------------------------------

function rendreContenu() {
  const items = missions.filter((m) => m.onglet === ongletActif);
  let html;

  if (items.length === 0) {
    html = messageVide(ongletActif);
  } else if (ongletActif === "A_RAMASSER") {
    html = rendreGroupesRamassage(items);
  } else if (ongletActif === "A_DEPOSER") {
    html = items.map(carteDepot).join("");
  } else if (ongletActif === "AU_HUB") {
    html = items.map(carteHub).join("");
  } else if (ongletActif === "RETOURS") {
    html = items.map(carteRetour).join("");
  } else {
    html = items.map(carteLivraison).join("");
  }

  // Le conteneur est réutilisé d'un onglet à l'autre : envelopper le rendu
  // dans un nœud frais à chaque appel permet à l'animation d'entrée de se
  // rejouer à chaque changement d'onglet (sinon la classe ne "bouge" jamais
  // et l'animation ne se déclenche qu'une fois).
  elContenu.innerHTML = `<div class="entree-contenu">${html}</div>`;
  attacherActions();
}

function messageVide(onglet) {
  const textes = {
    A_RAMASSER: "Aucun ramassage en attente. Les nouvelles commandes assignées apparaîtront ici.",
    A_DEPOSER: "Rien à déposer au hub pour le moment.",
    AU_HUB: "Rien à récupérer au hub pour le moment.",
    A_LIVRER: "Aucune livraison en cours. Va récupérer un lot au hub quand il est prêt.",
    RETOURS: "Aucun retour en cours."
  };
  return `<div class="etat-vide"><p>${textes[onglet]}</p></div>`;
}

function rendreGroupesRamassage(items) {
  const parCommande = new Map();
  items.forEach((m) => {
    if (!parCommande.has(m.id_commande)) parCommande.set(m.id_commande, []);
    parCommande.get(m.id_commande).push(m);
  });
  return Array.from(parCommande.entries()).map(([idCommande, colis]) => {
    const premier = colis[0];
    const lien = urlItineraire(premier.gps_expediteur || premier.expediteur_adresse);

    // NOUVEAU : mode PAR_EXPEDITEUR réellement collecté au ramassage (avant :
    // simple étiquette, jamais facturé nulle part). Tant que tous les colis
    // de la commande n'ont pas de paiement expéditeur, on affiche le montant
    // à encaisser au lieu du bouton de confirmation.
    const restantAPayer = premier.mode_paiement === "PAR_EXPEDITEUR"
      ? colis.filter((c) => !c.paye_par_expediteur)
      : [];
    const totalRestant = restantAPayer.reduce((s, c) => s + Number(c.montant_livraison || 0), 0);

    return `
      <div class="carte-mission">
        <div class="carte-en-tete">
          <div>
            <div class="carte-nom">${escapeHtml(premier.expediteur_nom)}</div>
            <div class="carte-sous"><a class="lien-tel" href="tel:${escapeHtml(premier.expediteur_tel)}">📞 ${escapeHtml(premier.expediteur_tel)}</a> · ${colis.length} colis</div>
            <div class="carte-id">${escapeHtml(idCommande)}</div>
          </div>
          <span class="puce attente">À ramasser</span>
        </div>
        ${premier.expediteur_adresse ? `<div class="carte-adresse">${iconePin()} ${escapeHtml(premier.expediteur_adresse)}</div>` : ""}
        ${lien ? `<a class="lien-carte" href="${lien}" target="_blank" rel="noopener">${iconeMap()} Itinéraire</a>` : ""}
        <div class="carte-actions">
          ${restantAPayer.length
            ? `<button class="btn btn-primaire btn-pleine-largeur" data-action="payer-ramassage" data-commande="${idCommande}">Encaisser ${formaterFcfa(totalRestant)} FCFA (expéditeur)</button>`
            : `<button class="btn btn-primaire btn-pleine-largeur" data-action="ramasser" data-commande="${idCommande}">J'ai récupéré les colis</button>`}
        </div>
      </div>`;
  }).join("");
}

function carteDepot(m) {
  const enAttenteValidation = m.statut === "DEPOT_DEMANDE" || m.statut === "RETOUR_DEMANDE";
  const estRetour = m.statut === "RETOUR_EN_COURS" || m.statut === "RETOUR_DEMANDE";
  const puce = enAttenteValidation
    ? `<span class="puce attente">En attente du hub</span>`
    : `<span class="puce ${estRetour ? "alerte" : "attente"}">${estRetour ? "Retour" : "Ramassé"}</span>`;

  let action = "";
  if (m.statut === "RAMASSE") {
    const nomHub = hubsDisponibles.find((h) => h.id_hub === m.id_hub_prevu)?.nom;
    action = `<button class="btn btn-primaire btn-pleine-largeur" data-action="demander-depot" data-colis="${m.id_colis}">Déposer${nomHub ? ` au ${escapeHtml(nomHub)}` : " au hub"}</button>`;
  } else if (m.statut === "RETOUR_EN_COURS") {
    action = `<button class="btn btn-alerte btn-pleine-largeur" data-action="demander-depot-retour" data-colis="${m.id_colis}">Déposer le retour au hub</button>`;
  }

  return `
    <div class="carte-mission">
      <div class="carte-en-tete">
        <div>
          <div class="carte-nom">${escapeHtml(m.destinataire_nom)}</div>
          <div class="carte-sous">${escapeHtml(m.id_commande)} · ${escapeHtml(m.id_colis)}${m.motif_retour ? " · " + libelleMotif(m.motif_retour) : ""}</div>
        </div>
        ${puce}
      </div>
      ${action ? `<div class="carte-actions">${action}</div>` : ""}
    </div>`;
}

// Onglet "Au hub" : tout ce qui attend que le livreur passe le récupérer
// physiquement — un lot de livraison normal, ou un colis à ramener chez
// l'expéditeur. Avant, ces deux cas étaient mélangés dans "À livrer" comme
// si le livreur les avait déjà en main, ce qui n'était pas le cas.
function carteHub(m) {
  const estRetour = m.statut === "RETOUR_ASSIGNE" || m.statut === "RETOUR_RECUP_DEMANDEE";
  const enAttenteValidation = m.statut === "RECUP_DEMANDEE" || m.statut === "RETOUR_RECUP_DEMANDEE";
  const puce = enAttenteValidation
    ? `<span class="puce attente">En attente du hub</span>`
    : `<span class="puce ${estRetour ? "alerte" : "attente"}">${estRetour ? "Retour à récupérer" : "Au hub"}</span>`;

  let action = "";
  if (m.statut === "EN_LOT") {
    action = `<button class="btn btn-primaire btn-pleine-largeur" data-action="recuperer" data-colis="${m.id_colis}">Récupérer au hub</button>`;
  } else if (m.statut === "RETOUR_ASSIGNE") {
    action = `<button class="btn btn-alerte btn-pleine-largeur" data-action="recuperer-retour" data-colis="${m.id_colis}">Récupérer le retour au hub</button>`;
  }

  return `
    <div class="carte-mission">
      <div class="carte-en-tete">
        <div>
          <div class="carte-nom">${escapeHtml(m.destinataire_nom)}</div>
          <div class="carte-sous">${escapeHtml(m.id_commande)} · ${escapeHtml(m.id_colis)}${m.code_zone ? " · " + escapeHtml(m.code_zone) : ""}</div>
        </div>
        ${puce}
      </div>
      ${action ? `<div class="carte-actions">${action}</div>` : ""}
    </div>`;
}

function carteLivraison(m) {
  const lien = urlItineraire(m.gps_destinataire || m.destinataire_adresse);
  const puce = m.paye
    ? `<span class="puce valide">Payé</span>`
    : `<span class="puce attente">${formaterFcfa(m.montant_livraison)} FCFA dû</span>`;
  const actions = `
    <button class="btn btn-primaire" data-action="livrer" data-colis="${m.id_colis}">Valider la livraison</button>
    <button class="btn btn-alerte" data-action="echec" data-colis="${m.id_colis}">Échec</button>`;

  return `
    <div class="carte-mission">
      <div class="carte-en-tete">
        <div>
          <div class="carte-nom">${escapeHtml(m.destinataire_nom)}</div>
          <div class="carte-sous"><a class="lien-tel" href="tel:${escapeHtml(m.destinataire_tel)}">📞 ${escapeHtml(m.destinataire_tel)}</a>${m.code_zone ? " · " + escapeHtml(m.code_zone) : ""}</div>
          <div class="carte-id">${escapeHtml(m.id_commande)} · ${escapeHtml(m.id_colis)}</div>
        </div>
        ${puce}
      </div>
      ${m.destinataire_adresse ? `<div class="carte-adresse">${iconePin()} ${escapeHtml(m.destinataire_adresse)}</div>` : ""}
      ${lien ? `<a class="lien-carte" href="${lien}" target="_blank" rel="noopener">${iconeMap()} Itinéraire</a>` : ""}
      <div class="carte-actions">${actions}</div>
    </div>`;
}

// Onglet "Retours" : le colis revient chez l'EXPÉDITEUR, pas chez le
// destinataire — adresse et itinéraire pointent donc vers l'expéditeur.
// Le paiement (si dû) est désormais à la charge de l'expéditeur, encaissé
// avant la validation finale, avec un code de retour distinct du code de
// ramassage (faille corrigée : l'ancien code ne fonctionne plus ici).
function carteRetour(m) {
  const lien = urlItineraire(m.gps_expediteur || m.expediteur_adresse);
  const puce = (!m.paye_par_expediteur && m.mode_paiement !== "SANS_PAIEMENT")
    ? `<span class="puce attente">${formaterFcfa(m.montant_livraison)} FCFA dû (expéditeur)</span>`
    : `<span class="puce alerte">Retour à l'expéditeur</span>`;

  return `
    <div class="carte-mission">
      <div class="carte-en-tete">
        <div>
          <div class="carte-nom">${escapeHtml(m.expediteur_nom)}</div>
          <div class="carte-sous"><a class="lien-tel" href="tel:${escapeHtml(m.expediteur_tel)}">📞 ${escapeHtml(m.expediteur_tel)}</a></div>
          <div class="carte-id">${escapeHtml(m.id_commande)} · ${escapeHtml(m.id_colis)}${m.motif_retour ? " · " + libelleMotif(m.motif_retour) : ""}</div>
        </div>
        ${puce}
      </div>
      ${m.expediteur_adresse ? `<div class="carte-adresse">${iconePin()} ${escapeHtml(m.expediteur_adresse)}</div>` : ""}
      ${lien ? `<a class="lien-carte" href="${lien}" target="_blank" rel="noopener">${iconeMap()} Itinéraire</a>` : ""}
      <div class="carte-actions">
        <button class="btn btn-primaire btn-pleine-largeur" data-action="remise-expediteur" data-colis="${m.id_colis}">Valider la remise</button>
      </div>
    </div>`;
}

function libelleMotif(code) {
  return MOTIFS.find((m) => m.code === code)?.libelle || code;
}

function escapeHtml(texte) {
  const div = document.createElement("div");
  div.textContent = String(texte ?? "");
  return div.innerHTML;
}

// Lien d'itinéraire : priorité à la position GPS partagée si elle existe,
// sinon on retombe sur l'adresse écrite — jamais bloquant, l'adresse texte
// reste toujours cliquable même sans position exacte (utile aussi pour
// vérifier que l'adresse écrite est la bonne, en la voyant sur la carte).
function urlItineraire(adresseOuGps) {
  if (adresseOuGps && typeof adresseOuGps === "object" && adresseOuGps.lat != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${adresseOuGps.lat},${adresseOuGps.lng}`;
  }
  const adresse = String(adresseOuGps || "").trim();
  if (!adresse) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(adresse)}`;
}

function iconePin() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
}
function iconeMap() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 20l-6 3V7l6-3 6 3 6-3v16l-6 3-6-3z"/></svg>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function attacherActions() {
  elContenu.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => gererAction(btn.dataset));
  });
}

function ouvrirSaisieCodeRamassage(idCommande) {
  return ouvrirSaisieCode({
    titre: "Code de ramassage",
    sousTitre: "Demande le code à l'expéditeur pour confirmer que tu as bien les colis.",
    onValider: async (code) => {
      const r = await validerRamassage(idCommande, code);
      if (r.ok) { afficherFlash("Ramassage confirmé"); fermerVoile(); rafraichir(); }
      return r;
    }
  });
}

async function gererAction(dataset) {
  const { action, colis, commande } = dataset;
  if (action === "ramasser") return ouvrirSaisieCodeRamassage(commande);

  if (action === "payer-ramassage") {
    const colisCommande = missions.filter((m) => m.id_commande === commande);
    return ouvrirChoixPaiementRamassage(colisCommande.filter((c) => !c.paye_par_expediteur));
  }

  // Dépôt normal : plus de choix de hub — toujours celui de l'assignation,
  // silencieusement (le serveur l'impose de toute façon). Seul le dépôt
  // d'un retour (échec de livraison) garde la liberté de choisir un hub
  // différent, voir demanderDepotRetour / ouvrirChoixHubDepot plus bas.
  if (action === "demander-depot") {
    const mission = missions.find((m) => m.id_colis === colis);
    return executerSimple(async () => {
      const r = await demanderDepot(colis);
      if (r.ok && mission?.id_hub_prevu) {
        creerNotification(null, mission.id_hub_prevu, "DEPOT_A_VALIDER", `Nouveau dépôt à valider (${colis})`, null).catch(() => {});
      }
      return r;
    }, "Dépôt demandé, en attente de validation au hub");
  }
  if (action === "demander-depot-retour") {
    const mission = missions.find((m) => m.id_colis === colis);
    const { idHub, motif } = await ouvrirChoixHubDepotRetour(colis, mission?.id_hub_prevu || null);
    return executerSimple(async () => {
      const r = await demanderDepotRetour(colis, idHub, motif);
      if (r.ok && idHub) {
        creerNotification(null, idHub, "RETOUR_A_VALIDER", `Retour à valider (${colis})${motif ? " — " + motif : ""}`, null).catch(() => {});
      }
      return r;
    }, "Retour signalé au hub");
  }
  if (action === "recuperer") return executerSimple(() => demanderRecuperation(colis), "Récupération demandée, en attente de validation au hub");
  if (action === "recuperer-retour") return executerSimple(() => demanderRecuperationRetour(colis), "Récupération du retour demandée, en attente de validation au hub");

  if (action === "livrer") {
    const mission = missions.find((m) => m.id_colis === colis);
    if (mission.mode_paiement === "A_LA_LIVRAISON" && !mission.paye) {
      return ouvrirChoixPaiement(mission);
    }
    return ouvrirSaisieCodeLivraison(colis);
  }

  if (action === "echec") return ouvrirChoixMotif(colis);
  if (action === "remise-expediteur") {
    const mission = missions.find((m) => m.id_colis === colis);
    // Le colis revient parce que le destinataire n'a pas payé (jamais livré) :
    // c'est désormais à l'expéditeur de régler avant la remise finale.
    if (mission.mode_paiement !== "SANS_PAIEMENT" && !mission.paye_par_expediteur) {
      return ouvrirChoixPaiementRetour(mission);
    }
    return ouvrirSaisieCodeRetour(colis);
  }
}

// Choix du hub réel au moment du dépôt d'un retour (échec de livraison) —
// pré-rempli avec le hub de la commande, mais librement modifiable : c'est
// le seul cas où un dépôt à un autre hub est permis (point relais), sans
// justification à donner (contrairement à un dépôt normal, qui n'a plus ce
// choix du tout — toujours le hub d'assignation, automatiquement).
function ouvrirChoixHubDepotRetour(idColis, idHubPrevu) {
  return new Promise((resolve) => {
    if (!hubsDisponibles.length) { resolve({ idHub: null, motif: null }); return; }
    ouvrirVoile(`
      <h2 class="feuille-titre">Déposer le retour</h2>
      <p class="feuille-sous">Par défaut, au hub de la commande. Le client n'a pas pu être livré ? Tu peux choisir le hub le plus proche de toi.</p>
      <div class="champ">
        <label>Hub de dépôt</label>
        <select id="select-hub-depot">
          ${hubsDisponibles.map((h) => `<option value="${h.id_hub}" ${h.id_hub === idHubPrevu ? "selected" : ""}>${escapeHtml(h.nom)}</option>`).join("")}
        </select>
        <div class="carte-adresse" id="adresse-hub-depot" style="margin-top:8px;"></div>
      </div>
      <button class="btn btn-primaire btn-pleine-largeur" id="btn-confirmer-hub" type="button">Confirmer le dépôt</button>
    `, (voile) => {
      const select = voile.querySelector("#select-hub-depot");
      const elAdresse = voile.querySelector("#adresse-hub-depot");
      function afficherAdresse() {
        const hub = hubsDisponibles.find((h) => h.id_hub === select.value);
        elAdresse.innerHTML = hub?.adresse ? `${iconePin()} ${escapeHtml(hub.adresse)}` : "";
      }
      select.addEventListener("change", afficherAdresse);
      afficherAdresse(); // affichée dès l'ouverture, pas seulement au changement

      voile.querySelector("#btn-confirmer-hub").addEventListener("click", () => {
        const idHub = select.value;
        fermerVoile();
        resolve({ idHub, motif: null });
      });
    });
  });
}

async function executerSimple(action, messageSucces) {
  const r = await action();
  if (r.ok) { afficherFlash(messageSucces); rafraichir(); }
  else afficherFlash(r.message || "Une erreur est survenue.");
}

function ouvrirSaisieCode({ titre, sousTitre, onValider }) {
  ouvrirVoile(`
    <h2 class="feuille-titre">${titre}</h2>
    <p class="feuille-sous">${sousTitre}</p>
    <p class="message-erreur" id="erreur-code"></p>
    <input class="saisie-code" id="champ-code" inputmode="text" maxlength="8" placeholder="______" autofocus>
    <div class="carte-actions" style="margin-top:16px;">
      <button class="btn btn-discret" id="btn-annuler-code" type="button">Annuler</button>
      <button class="btn btn-primaire" id="btn-confirmer-code" type="button">Confirmer</button>
    </div>
  `, (voile) => {
    const champ = voile.querySelector("#champ-code");
    const erreur = voile.querySelector("#erreur-code");
    champ.focus();
    voile.querySelector("#btn-annuler-code").addEventListener("click", fermerVoile);
    voile.querySelector("#btn-confirmer-code").addEventListener("click", async (e) => {
      const bouton = e.currentTarget;
      const code = champ.value.trim();
      if (!code) return;
      bouton.disabled = true; bouton.textContent = "Vérification...";
      const r = await onValider(code);
      if (!r.ok) {
        erreur.textContent = r.message || "Code incorrect.";
        erreur.classList.add("visible");
        bouton.disabled = false; bouton.textContent = "Confirmer";
      }
    });
  });
}

function ouvrirSaisieCodeLivraison(idColis) {
  ouvrirSaisieCode({
    titre: "Code de livraison",
    sousTitre: "Demande le code au destinataire pour confirmer la remise du colis.",
    onValider: async (code) => {
      const r = await validerLivraison(idColis, code);
      if (r.ok) { afficherFlash("Livraison confirmée"); fermerVoile(); rafraichir(); }
      return r;
    }
  });
}

function ouvrirSaisieCodeRetour(idColis) {
  ouvrirSaisieCode({
    titre: "Code de retour",
    sousTitre: "Demande à l'expéditeur le code qui lui a été envoyé pour ce retour (différent du code de ramassage initial).",
    onValider: async (code) => {
      const r = await validerRemiseExpediteur(idColis, code);
      if (r.ok) { afficherFlash("Colis rendu à l'expéditeur"); fermerVoile(); rafraichir(); }
      return r;
    }
  });
}

// Confirmation explicite avant tout encaissement en espèces : un gros popup
// qui demande de confirmer avoir bien reçu l'argent, avant même la saisie
// du code. Sécurité anti-erreur/anti-fraude — le paiement n'est enregistré
// qu'après un "oui" explicite, jamais en un seul tap depuis la liste.
function confirmerEncaissementEspeces(montant, qui) {
  return new Promise((resolve) => {
    ouvrirVoile(`
      <h2 class="feuille-titre">Confirmer l'encaissement</h2>
      <p class="feuille-sous" style="font-size:16px;line-height:1.5;">
        Vous confirmez avoir récupéré <strong>${formaterFcfa(montant)} FCFA</strong> avec ${qui} ?
      </p>
      <button class="btn btn-primaire btn-pleine-largeur" id="btn-confirmer-encaissement" type="button">Oui, j'ai bien reçu l'argent</button>
      <button class="btn btn-discret btn-pleine-largeur" id="btn-annuler-encaissement" type="button" style="margin-top:10px;">Annuler</button>
    `, (voile) => {
      voile.querySelector("#btn-confirmer-encaissement").addEventListener("click", () => resolve(true));
      voile.querySelector("#btn-annuler-encaissement").addEventListener("click", () => resolve(false));
    });
  });
}

function ouvrirChoixPaiement(mission) {
  ouvrirVoile(`
    <h2 class="feuille-titre">Encaisser ${formaterFcfa(mission.montant_livraison)} FCFA</h2>
    <p class="feuille-sous">Choisis le mode de paiement du destinataire avant de valider la livraison.</p>
    <p class="message-erreur" id="erreur-paiement"></p>
    <div class="choix-paiement">
      <button class="option-paiement" data-methode="ESPECES" type="button">
        <div>
          <div class="libelle">Espèces</div>
          <div class="detail">Le montant sera ajouté à ta caisse du jour.</div>
        </div>
      </button>
      <button class="option-paiement" data-methode="WAVE" type="button">
        <div>
          <div class="libelle">Wave</div>
          <div class="detail">Le client paie depuis son téléphone.</div>
        </div>
      </button>
    </div>
    <button class="btn btn-discret btn-pleine-largeur" id="btn-annuler-paiement" type="button">Annuler</button>
  `, (voile) => {
    voile.querySelector("#btn-annuler-paiement").addEventListener("click", fermerVoile);
    voile.querySelectorAll(".option-paiement").forEach((opt) => {
      opt.addEventListener("click", async () => {
        const methode = opt.dataset.methode;
        const erreur = voile.querySelector("#erreur-paiement");
        voile.querySelectorAll(".option-paiement").forEach((o) => o.setAttribute("aria-pressed", "false"));
        opt.setAttribute("aria-pressed", "true");

        if (methode === "ESPECES") {
          const confirme = await confirmerEncaissementEspeces(mission.montant_livraison, "le destinataire");
          if (!confirme) { fermerVoile(); return; }
          const r = await encaisserEspeces(mission.id_colis);
          if (!r.ok) { ouvrirChoixPaiement(mission); afficherFlash(r.message || "Erreur d'encaissement.", true); return; }
          fermerVoile();
          ouvrirSaisieCodeLivraison(mission.id_colis);
          return;
        }

        // WAVE : on cree une vraie session de paiement, puis on affiche un
        // lien reel (obligatoire selon Wave : jamais ouvert en webview/fetch)
        // pendant qu'on attend la confirmation du webhook en arriere-plan.
        opt.querySelector(".detail").textContent = "Création du paiement Wave…";
        const init = await initierPaiementWave(mission.id_colis);
        if (!init.ok) { erreur.textContent = init.message || "Erreur Wave."; erreur.classList.add("visible"); return; }

        opt.innerHTML = `
          <div style="width:100%;">
            <div class="libelle">Wave</div>
            <a href="${init.waveLaunchUrl}" target="_blank" rel="noopener" class="btn btn-secondaire" style="margin-top:8px;display:flex;">Ouvrir Wave sur le téléphone du client</a>
            <div class="detail" id="detail-attente-wave" style="margin-top:8px;">En attente de la confirmation…</div>
          </div>`;

        const confirme = await attendreConfirmationWave(init.idPaiement);
        const detailAttente = voile.querySelector("#detail-attente-wave");
        if (confirme === true) {
          fermerVoile();
          ouvrirSaisieCodeLivraison(mission.id_colis);
        } else if (confirme === false) {
          erreur.textContent = "Paiement Wave échoué. Réessaie ou choisis Espèces.";
          erreur.classList.add("visible");
        } else if (detailAttente) {
          detailAttente.textContent = "Toujours en attente. Le client peut relancer le paiement en rouvrant le lien.";
        }
      });
    });
  });
}

// Paiement d'un retour : c'est l'expéditeur qui paie (le destinataire n'a
// jamais reçu le colis). Espèces ou Wave, comme pour une livraison normale.
function ouvrirChoixPaiementRetour(mission) {
  ouvrirVoile(`
    <h2 class="feuille-titre">Encaisser ${formaterFcfa(mission.montant_livraison)} FCFA</h2>
    <p class="feuille-sous">Le destinataire n'a pas reçu le colis : c'est l'expéditeur qui règle avant la remise.</p>
    <p class="message-erreur" id="erreur-paiement-retour"></p>
    <div class="choix-paiement">
      <button class="option-paiement" data-methode="ESPECES" type="button">
        <div>
          <div class="libelle">Espèces</div>
          <div class="detail">Le montant sera ajouté à ta caisse du jour.</div>
        </div>
      </button>
      <button class="option-paiement" data-methode="WAVE" type="button">
        <div>
          <div class="libelle">Wave</div>
          <div class="detail">L'expéditeur paie depuis son téléphone.</div>
        </div>
      </button>
    </div>
    <button class="btn btn-discret btn-pleine-largeur" id="btn-annuler-paiement-retour" type="button" style="margin-top:10px;">Annuler</button>
  `, (voile) => {
    voile.querySelector("#btn-annuler-paiement-retour").addEventListener("click", fermerVoile);
    voile.querySelectorAll(".option-paiement").forEach((opt) => {
      opt.addEventListener("click", async () => {
        const methode = opt.dataset.methode;
        const erreur = voile.querySelector("#erreur-paiement-retour");
        voile.querySelectorAll(".option-paiement").forEach((o) => o.setAttribute("aria-pressed", "false"));
        opt.setAttribute("aria-pressed", "true");

        if (methode === "ESPECES") {
          const confirme = await confirmerEncaissementEspeces(mission.montant_livraison, "l'expéditeur");
          if (!confirme) { fermerVoile(); return; }
          const r = await encaisserEspecesRetour(mission.id_colis);
          if (!r.ok) { ouvrirChoixPaiementRetour(mission); afficherFlash(r.message || "Erreur d'encaissement.", true); return; }
          fermerVoile();
          ouvrirSaisieCodeRetour(mission.id_colis);
          return;
        }

        opt.querySelector(".detail").textContent = "Création du paiement Wave…";
        const init = await initierPaiementWave(mission.id_colis, "retour");
        if (!init.ok) { erreur.textContent = init.message || "Erreur Wave."; erreur.classList.add("visible"); return; }

        opt.innerHTML = `
          <div style="width:100%;">
            <div class="libelle">Wave</div>
            <a href="${init.waveLaunchUrl}" target="_blank" rel="noopener" class="btn btn-secondaire" style="margin-top:8px;display:flex;">Ouvrir Wave sur le téléphone de l'expéditeur</a>
            <div class="detail" id="detail-attente-wave-retour" style="margin-top:8px;">En attente de la confirmation…</div>
          </div>`;

        const confirme = await attendreConfirmationWave(init.idPaiement);
        const detailAttente = voile.querySelector("#detail-attente-wave-retour");
        if (confirme === true) {
          fermerVoile();
          ouvrirSaisieCodeRetour(mission.id_colis);
        } else if (confirme === false) {
          erreur.textContent = "Paiement Wave échoué. Réessaie ou choisis Espèces.";
          erreur.classList.add("visible");
        } else if (detailAttente) {
          detailAttente.textContent = "Toujours en attente. L'expéditeur peut relancer le paiement en rouvrant le lien.";
        }
      });
    });
  });
}

// Paiement PAR_EXPEDITEUR au ramassage. Une commande peut grouper plusieurs
// colis : l'espèces règle tout d'un coup (une ligne de caisse par colis en
// arrière-plan) ; Wave n'est proposé que pour un seul colis à la fois (une
// session de paiement Wave correspond à un seul colis dans ce système).
function ouvrirChoixPaiementRamassage(colisAPayer) {
  const total = colisAPayer.reduce((s, c) => s + Number(c.montant_livraison || 0), 0);
  ouvrirVoile(`
    <h2 class="feuille-titre">Encaisser ${formaterFcfa(total)} FCFA</h2>
    <p class="feuille-sous">L'expéditeur a choisi de payer lui-même la livraison, au ramassage.</p>
    <p class="message-erreur" id="erreur-paiement-ramassage"></p>
    <div class="choix-paiement">
      <button class="option-paiement" data-methode="ESPECES" type="button">
        <div>
          <div class="libelle">Espèces</div>
          <div class="detail">Le montant sera ajouté à ta caisse du jour.</div>
        </div>
      </button>
      <button class="option-paiement" data-methode="WAVE" type="button">
        <div>
          <div class="libelle">Wave</div>
          <div class="detail">L'expéditeur paie depuis son téléphone${colisAPayer.length > 1 ? " — un seul paiement pour toute la commande" : ""}.</div>
        </div>
      </button>
    </div>
    <button class="btn btn-discret btn-pleine-largeur" id="btn-annuler-paiement-ramassage" type="button" style="margin-top:10px;">Annuler</button>
  `, (voile) => {
    voile.querySelector("#btn-annuler-paiement-ramassage").addEventListener("click", fermerVoile);
    voile.querySelectorAll(".option-paiement").forEach((opt) => {
      opt.addEventListener("click", async () => {
        const methode = opt.dataset.methode;
        const erreur = voile.querySelector("#erreur-paiement-ramassage");

        if (methode === "ESPECES") {
          opt.setAttribute("aria-pressed", "true");
          const confirme = await confirmerEncaissementEspeces(total, "l'expéditeur");
          if (!confirme) { fermerVoile(); return; }
          for (const c of colisAPayer) {
            const r = await encaisserEspecesRamassage(c.id_colis);
            if (!r.ok) { ouvrirChoixPaiementRamassage(colisAPayer); afficherFlash(r.message || "Erreur d'encaissement.", true); return; }
          }
          afficherFlash("Paiement encaissé");
          // Enchaîne directement sur la saisie du code, sans repasser par la
          // carte de la commande — plus simple s'il y a plusieurs commandes
          // en attente (signalé : il fallait retrouver puis retaper sur la
          // bonne carte après le paiement, pas évident avec plusieurs commandes).
          ouvrirSaisieCodeRamassage(colisAPayer[0].id_commande);
          return;
        }

        opt.querySelector(".detail").textContent = "Création du paiement Wave…";
        const init = await initierPaiementWaveRamassageCommande(colisAPayer[0].id_commande);
        if (!init.ok) { erreur.textContent = init.message || "Erreur Wave."; erreur.classList.add("visible"); return; }

        opt.innerHTML = `
          <div style="width:100%;">
            <div class="libelle">Wave</div>
            <a href="${init.waveLaunchUrl}" target="_blank" rel="noopener" class="btn btn-secondaire" style="margin-top:8px;display:flex;">Ouvrir Wave sur le téléphone de l'expéditeur</a>
            <div class="detail" id="detail-attente-wave-ramassage" style="margin-top:8px;">En attente de la confirmation…</div>
          </div>`;

        const confirme = await attendreConfirmationWave(init.idPaiement);
        const detailAttente = voile.querySelector("#detail-attente-wave-ramassage");
        if (confirme === true) {
          afficherFlash("Paiement confirmé");
          ouvrirSaisieCodeRamassage(colisAPayer[0].id_commande);
        } else if (confirme === false) {
          erreur.textContent = "Paiement Wave échoué. Réessaie ou choisis Espèces.";
          erreur.classList.add("visible");
        } else if (detailAttente) {
          detailAttente.textContent = "Toujours en attente. L'expéditeur peut relancer le paiement en rouvrant le lien.";
        }
      });
    });
  });
}

function ouvrirChoixMotif(idColis) {
  ouvrirVoile(`
    <h2 class="feuille-titre">Pourquoi la livraison échoue ?</h2>
    <p class="feuille-sous">Choisis le motif le plus proche de la situation.</p>
    <p class="message-erreur" id="erreur-motif"></p>
    <div class="liste-motifs">
      ${MOTIFS.map((m) => `<button class="motif-item" data-motif="${m.code}" type="button">${m.libelle}</button>`).join("")}
    </div>
    <button class="btn btn-discret btn-pleine-largeur" id="btn-annuler-motif" type="button">Annuler</button>
  `, (voile) => {
    voile.querySelector("#btn-annuler-motif").addEventListener("click", fermerVoile);
    voile.querySelectorAll(".motif-item").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const r = await signalerEchec(idColis, btn.dataset.motif);
        if (r.ok) { afficherFlash("Échec signalé"); fermerVoile(); rafraichir(); }
        else {
          const erreur = voile.querySelector("#erreur-motif");
          erreur.textContent = r.message || "Erreur.";
          erreur.classList.add("visible");
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Ma caisse (accessible depuis le nom du hub, en haut)
// ---------------------------------------------------------------------------

function ouvrirMaCaisse() {
  const solde = window.__soldeCaisse || 0;
  ouvrirVoile(`
    <h2 class="feuille-titre">Ma caisse</h2>
    <p class="feuille-sous">Espèces encaissées non encore versées au hub.</p>
    <div class="caisse-solde">
      <div>
        <div class="label">Solde actuel</div>
        <div class="montant">${formaterFcfa(solde)} FCFA</div>
      </div>
    </div>
    <p class="message-erreur" id="erreur-versement"></p>
    <input class="saisie-code" id="montant-versement" inputmode="numeric" placeholder="Montant" style="letter-spacing:0.05em; font-size:20px;">
    <div class="carte-actions" style="margin-top:16px;">
      <button class="btn btn-discret" id="btn-annuler-versement" type="button">Fermer</button>
      <button class="btn btn-primaire" id="btn-verser" type="button">Verser au hub</button>
    </div>
  `, (voile) => {
    voile.querySelector("#btn-annuler-versement").addEventListener("click", fermerVoile);
    voile.querySelector("#btn-verser").addEventListener("click", async (e) => {
      const montant = Number(voile.querySelector("#montant-versement").value);
      const erreur = voile.querySelector("#erreur-versement");
      if (!montant || montant <= 0) { erreur.textContent = "Montant invalide."; erreur.classList.add("visible"); return; }
      const bouton = e.currentTarget;
      bouton.disabled = true;
      const r = await verserCaisse(montant);
      if (r.ok) { afficherFlash("Versement enregistré"); fermerVoile(); rafraichir(); }
      else { erreur.textContent = r.message || "Erreur."; erreur.classList.add("visible"); bouton.disabled = false; }
    });
  });
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

elBoutonsOnglet.forEach((btn) => {
  btn.addEventListener("click", () => {
    ongletActif = btn.dataset.onglet;
    sessionStorage.setItem("ikigai_onglet_actif", ongletActif);
    elBoutonsOnglet.forEach((b) => b.setAttribute("aria-current", String(b === btn)));
    rendreContenu();
  });
});
// Reflète l'onglet restauré (sessionStorage) sur les boutons dès le chargement —
// sinon le bouton "À ramasser" resterait visuellement actif même si un autre
// onglet est effectivement affiché.
elBoutonsOnglet.forEach((b) => b.setAttribute("aria-current", String(b.dataset.onglet === ongletActif)));

function ouvrirNotifications() {
  ouvrirVoile(`
    <div class="entete-notif" style="display:flex;justify-content:space-between;align-items:center;">
      <h2 class="feuille-titre" style="margin:0;">Notifications</h2>
      <button class="btn btn-discret btn-petit" id="btn-tout-lu" type="button">Tout marquer lu</button>
    </div>
    <div id="liste-notifs"><p class="feuille-sous">Chargement…</p></div>
  `, async (voile) => {
    const notifs = await listerMesNotifications();
    voile.querySelector("#liste-notifs").innerHTML = notifs.length
      ? notifs.map((n) => `
          <div class="ligne-notif ${n.lu ? "" : "non-lue"}" data-id="${n.id}">
            ${escapeHtml(n.message)}
            <div class="date-notif">${new Date(n.cree_le).toLocaleString("fr-FR")}</div>
          </div>`).join("")
      : `<p class="feuille-sous">Rien pour l'instant.</p>`;
    voile.querySelectorAll(".ligne-notif").forEach((el) => {
      el.addEventListener("click", async () => {
        if (el.classList.contains("non-lue")) {
          await marquerNotificationLue(el.dataset.id);
          el.classList.remove("non-lue");
          rafraichirCompteurNotifications();
        }
      });
    });
    voile.querySelector("#btn-tout-lu").addEventListener("click", async () => {
      await marquerToutesNotificationsLues();
      voile.querySelectorAll(".ligne-notif").forEach((el) => el.classList.remove("non-lue"));
      rafraichirCompteurNotifications();
    });
  });
}

async function rafraichirCompteurNotifications() {
  const n = await compterNotificationsNonLues();
  const bulle = document.querySelector("#bulle-notifications");
  if (n > 0) { bulle.textContent = n > 99 ? "99+" : String(n); bulle.hidden = false; }
  else bulle.hidden = true;
}

document.querySelector("#btn-deconnexion").addEventListener("click", deconnecterLivreur);
document.querySelector("#topbar-hub").addEventListener("click", ouvrirMaCaisse);
document.querySelector("#btn-notifications").addEventListener("click", ouvrirNotifications);

window.addEventListener("online", () => {
  document.querySelector("#point-connexion").classList.remove("hors-ligne");
  document.querySelector("#libelle-connexion").textContent = "En ligne";
  rafraichir({ silencieux: true });
});
window.addEventListener("offline", () => {
  document.querySelector("#point-connexion").classList.add("hors-ligne");
  document.querySelector("#libelle-connexion").textContent = "Hors ligne";
});

(async function demarrer() {
  profil = await garantirAccesLivreur();
  if (!profil) return; // déjà redirigé
  document.querySelector("#topbar-nom").textContent = profil.nom;
  document.querySelector("#topbar-hub").textContent = "Ma caisse ›";
  listerHubs().then((h) => {
    hubsDisponibles = h;
    const monHub = h.find((hub) => hub.id_hub === profil.id_hub_affecte);
    if (monHub) {
      const lien = document.querySelector("#lien-hub");
      document.querySelector("#lien-hub-texte").textContent = `Itinéraire vers ${monHub.nom}`;
      lien.href = urlItineraire(monHub.adresse);
      lien.hidden = false;
    }
  }).catch(() => {});
  await rafraichir();
  rafraichirCompteurNotifications();
  setInterval(() => rafraichir({ silencieux: true }), 25000);
  setInterval(rafraichirCompteurNotifications, 25000);
})();
