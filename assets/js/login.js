import { connecterLivreur, chargerProfilLivreur } from "./auth.js";

const form = document.querySelector("#form-connexion");
const bouton = document.querySelector("#bouton-connexion");
const messageErreur = document.querySelector("#message-erreur");

// Déjà connecté ? On saute directement au tableau de bord.
(async () => {
  const profil = await chargerProfilLivreur();
  if (profil) window.location.href = "./app.html";
})();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  messageErreur.textContent = "";
  bouton.disabled = true;
  bouton.textContent = "Connexion...";

  const email = document.querySelector("#email").value.trim();
  const password = document.querySelector("#password").value;

  const resultat = await connecterLivreur(email, password);
  if (!resultat.ok) {
    messageErreur.textContent = resultat.message;
    bouton.disabled = false;
    bouton.textContent = "Se connecter";
    return;
  }
  window.location.href = "./app.html";
});
