/**
 * BRAVO' Boutique — Serveur proxy sécurisé pour l'API Jeel (jeko.africa)
 * Les clés API ne sont JAMAIS exposées au frontend.
 *
 * Déploiement : Node.js 18+
 *   npm install && node server.js
 *
 * Variables d'environnement (recommandé en prod) :
 *   JEEL_API_KEY, JEEL_WEBHOOK_SECRET, JEEL_ENTITY_ID, PORT
 */

const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const path     = require('path');

const app = express();
app.use(express.json());

// ─── CONFIGURATION JEEL (côté serveur uniquement) ───────────────────────────
const JEEL_CONFIG = {
  apiKey        : process.env.JEEL_API_KEY        || 'jeko_f70fbdff8b2818643e85f1be4926f2554465ef2be1910c39f96653684e14d552',
  webhookSecret : process.env.JEEL_WEBHOOK_SECRET || 'b44c0c278beab8b3717d13028b9395f269fa2a6c870f856746407847634c6c3b',
  entityId      : process.env.JEEL_ENTITY_ID      || '4a2ba0a5-40de-4e00-830e-b03cc5af1223',
  baseUrl       : 'https://api.sandbox.jeel.co',   // ← remplacer par https://api.jeel.co en production
};

// ─── CORS : autoriser uniquement business.jeko.africa ───────────────────────
app.use(cors());

// ─── Servir les fichiers statiques du PWA ───────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ════════════════════════════════════════════════════════════════════════════
// ROUTE 1 : Créer un checkout Jeel
// POST /api/jeel/checkout
// Body : { orderId, customerName, customerPhone, customerEmail, items, total, deliveryType }
// ════════════════════════════════════════════════════════════════════════════
app.post('/api/jeel/checkout', async (req, res) => {
  try {
    const {
      orderId,
      customerName,
      customerPhone,
      customerEmail,
      items,          // [{ name, price, qty }]
      total,          // montant total en FCFA (entier)
      deliveryType,
    } = req.body;

    // Validation minimale
    if (!orderId || !customerName || !customerPhone || !items?.length || !total) {
      return res.status(400).json({ error: 'Paramètres manquants' });
    }

    // Construire le prénom / nom depuis le champ "customerName" (ex: "Ahmed Mohamed")
    const nameParts   = (customerName || '').trim().split(/\s+/);
    const firstName   = nameParts[0] || 'Client';
    const lastName    = nameParts.slice(1).join(' ') || 'BRAVO';

    // Construire le payload Jeel
    const jeelPayload = {
      reference_id : orderId,
      buyer: {
        first_name    : firstName,
        last_name     : lastName,
        mobile_number : customerPhone.replace(/^\+?225/, '').replace(/\s/g, ''), // retirer indicatif CI
        email         : customerEmail || `client+${orderId}@bravo-boutique.ci`,
      },
      items: items.map(item => ({
        item_name    : item.name,
        quantity     : item.qty,
        unit_price   : item.price,       // en FCFA
        total_cost   : item.price * item.qty,
        reference_id : `${orderId}-${item.id || item.name.slice(0, 8)}`,
        entity_id    : JEEL_CONFIG.entityId,
      })),
      urls: {
        redirect_url     : `https://business.jeko.africa/merci?order=${orderId}`,
        notification_url : `https://business.jeko.africa/api/jeel/webhook`,
      },
      metadata: {
        source      : 'bravo-boutique-pwa',
        deliveryType: deliveryType || 'standard',
        orderId,
      },
    };

    // Appel API Jeel
    const jeelRes = await fetch(`${JEEL_CONFIG.baseUrl}/v3/checkout`, {
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Authorization' : `Bearer ${JEEL_CONFIG.apiKey}`,
      },
      body: JSON.stringify(jeelPayload),
    });

    const jeelData = await jeelRes.json();

    if (!jeelRes.ok) {
      console.error('[Jeel] Erreur checkout :', jeelData);
      return res.status(jeelRes.status).json({ error: jeelData?.message || 'Erreur Jeel' });
    }

    // Retourner au frontend uniquement ce dont il a besoin
    return res.json({
      checkout_id  : jeelData.checkout_id,
      redirect_url : jeelData.redirect_url,
      reference_id : jeelData.reference_id,
    });

  } catch (err) {
    console.error('[Jeel] Exception checkout :', err);
    return res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE 2 : Vérifier le statut d'un checkout
// GET /api/jeel/checkout/:checkoutId
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/jeel/checkout/:checkoutId', async (req, res) => {
  try {
    const { checkoutId } = req.params;

    const jeelRes = await fetch(`${JEEL_CONFIG.baseUrl}/v3/checkout/${checkoutId}`, {
      method  : 'GET',
      headers : {
        'Authorization' : `Bearer ${JEEL_CONFIG.apiKey}`,
        'Accept'        : 'application/json',
      },
    });

    const jeelData = await jeelRes.json();

    if (!jeelRes.ok) {
      return res.status(jeelRes.status).json({ error: jeelData?.message || 'Erreur Jeel' });
    }

    return res.json({
      checkout_id   : jeelData.checkout_id,
      status        : jeelData.status,        // PENDING | SUCCEEDED | REJECTED | EXPIRED
      checkout_type : jeelData.checkout_type,
      reference_id  : jeelData.reference_id,
    });

  } catch (err) {
    console.error('[Jeel] Exception status :', err);
    return res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE 3 : Webhook Jeel (notification de paiement)
// POST /api/jeel/webhook
// Jeel envoie une notification quand le statut change
// ════════════════════════════════════════════════════════════════════════════
app.post('/api/jeel/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Vérifier la signature HMAC du webhook
    const signature  = req.headers['x-jeel-signature'] || req.headers['x-webhook-signature'] || '';
    const rawBody    = req.body; // Buffer grâce à express.raw()
    const expected   = crypto
      .createHmac('sha256', JEEL_CONFIG.webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (signature && signature !== expected) {
      console.warn('[Webhook] Signature invalide — requête rejetée');
      return res.status(401).json({ error: 'Signature invalide' });
    }

    const event = JSON.parse(rawBody.toString());
    console.log('[Webhook] Événement reçu :', JSON.stringify(event, null, 2));

    const { checkout_id, status, reference_id } = event;

    // ── Mettre à jour Firebase selon le statut ──────────────────────────
    // Firebase Admin SDK — à initialiser si besoin (voir README)
    // Pour l'instant : log + 200 OK (tu peux brancher Firestore ici)
    if (status === 'SUCCEEDED') {
      console.log(`✅ Paiement réussi : commande ${reference_id} (checkout ${checkout_id})`);
      // TODO : mettre à jour boutique_orders dans Firestore → status: 'paid'
    } else if (status === 'REJECTED') {
      console.log(`❌ Paiement rejeté : commande ${reference_id}`);
      // TODO : marquer comme rejeté dans Firestore
    } else if (status === 'EXPIRED') {
      console.log(`⏰ Checkout expiré : commande ${reference_id}`);
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('[Webhook] Erreur :', err);
    return res.status(500).json({ error: 'Erreur traitement webhook' });
  }
});

// ─── Démarrage ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur BRAVO' / Jeel démarré sur le port ${PORT}`);
  console.log(`   API Jeel : ${JEEL_CONFIG.baseUrl}`);
  console.log(`   Entity ID: ${JEEL_CONFIG.entityId}`);
});
