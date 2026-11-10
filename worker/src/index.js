// Proxy Marcel : garde la clé Groq côté serveur et filtre les appels du widget.
// Déploiement : npx wrangler deploy (depuis le dossier worker/)

const ORIGINES = [
  "https://gite.hourdeau.com",
  "https://gite-hourdeau.odoo.com"
];
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODELE = "openai/gpt-oss-120b";
const MAX_TOKENS = 1500;
const MAX_MESSAGES = 14;      // prompt système + 12 messages d'historique + marge
const MAX_TAILLE = 60000;     // taille maximale du corps de requête (caractères)

function enTetesCors(origine) {
  return {
    "Access-Control-Allow-Origin": origine,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function erreur(statut, message, origine) {
  return new Response(JSON.stringify({ error: { message: message } }), {
    status: statut,
    headers: Object.assign({ "Content-Type": "application/json" }, origine ? enTetesCors(origine) : {})
  });
}

export default {
  async fetch(request, env) {
    const origine = request.headers.get("Origin") || "";
    const autorise = ORIGINES.includes(origine);

    // Requête préalable CORS envoyée par le navigateur
    if (request.method === "OPTIONS") {
      return autorise
        ? new Response(null, { status: 204, headers: enTetesCors(origine) })
        : new Response(null, { status: 403 });
    }
    if (request.method !== "POST") return erreur(405, "Méthode non autorisée", autorise ? origine : "");
    if (!autorise) return erreur(403, "Origine non autorisée", "");

    // Limitation par adresse IP
    const ip = request.headers.get("CF-Connecting-IP") || "inconnue";
    const resultat = await env.LIMITEUR.limit({ key: ip });
    if (!resultat.success) return erreur(429, "Trop de requêtes", origine);

    // Contrôle du contenu
    const texte = await request.text();
    if (texte.length > MAX_TAILLE) return erreur(413, "Requête trop volumineuse", origine);
    let corps;
    try { corps = JSON.parse(texte); } catch (e) { return erreur(400, "JSON invalide", origine); }
    if (!Array.isArray(corps.messages) || corps.messages.length === 0 || corps.messages.length > MAX_MESSAGES) {
      return erreur(400, "Messages invalides", origine);
    }
    const messages = corps.messages
      .filter(function (m) { return m && ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string"; })
      .map(function (m) { return { role: m.role, content: m.content }; });

    // Paramètres imposés par le serveur : ceux envoyés par le navigateur sont ignorés
    const charge = {
      model: MODELE,
      messages: messages,
      temperature: 0.4,
      max_tokens: MAX_TOKENS,
      reasoning_effort: "low"
    };

    const reponse = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.GROQ_API_KEY },
      body: JSON.stringify(charge)
    });

    return new Response(reponse.body, {
      status: reponse.status,
      headers: Object.assign({ "Content-Type": "application/json" }, enTetesCors(origine))
    });
  }
};
