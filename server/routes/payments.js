const express = require('express');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const PACKAGES = {
  '49': { amount_inr: 49, coins: 125 },
  '99': { amount_inr: 99, coins: 270 },
  '249': { amount_inr: 249, coins: 625 },
  '999': { amount_inr: 999, coins: 2700 }
};

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

let razorpay = null;
if (KEY_ID && KEY_SECRET) {
  const Razorpay = require('razorpay');
  razorpay = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
}

// Coins are only ever credited inside this one function, and only once per
// payment row (guarded by the payment_status check), so it's safe to call
// this from BOTH the client-side verify endpoint AND the server-to-server
// webhook without ever double-crediting a user.
function creditPaymentIfPending(paymentId, providerPaymentId) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment) return { ok: false, reason: 'not_found' };
  if (payment.payment_status === 'success') return { ok: true, already: true, payment };

  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE payments SET payment_status = 'success', provider_transaction_id = ?, updated_at = ? WHERE id = ?`)
      .run(providerPaymentId, now, payment.id);

    db.prepare('UPDATE users SET spendable_coins = spendable_coins + ?, updated_at = ? WHERE id = ?')
      .run(payment.coins, now, payment.user_id);

    db.prepare(`INSERT INTO coin_transactions (id, user_id, type, amount, source, balance_type, status, meta, created_at)
                VALUES (?, ?, 'credit', ?, 'purchase', 'spendable', 'completed', ?, ?)`)
      .run(uuid(), payment.user_id, payment.coins, JSON.stringify({ payment_id: payment.id }), now);
  });
  tx();
  return { ok: true, already: false, payment };
}

router.get('/packages', (req, res) => res.json({ packages: PACKAGES, configured: !!razorpay }));

// STEP 1 - Create a real Razorpay order. The client uses this order id to
// open Razorpay's Checkout widget - no coins are credited at this point.
router.post('/create', requireAuth, async (req, res) => {
  const { package_label } = req.body;
  const pkg = PACKAGES[package_label];
  if (!pkg) return res.status(400).json({ error: 'invalid_package' });
  if (!razorpay) {
    return res.status(400).json({
      error: 'payment_gateway_not_configured',
      message: 'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in server/.env (use test mode keys to try it out for free).'
    });
  }

  try {
    const order = await razorpay.orders.create({
      amount: pkg.amount_inr * 100, // paise
      currency: 'INR',
      receipt: 'vizo_' + Date.now()
    });

    const id = uuid();
    const now = Date.now();
    db.prepare(`INSERT INTO payments (id, user_id, package_label, amount_inr, coins, payment_status, provider_order_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(id, req.user.id, package_label, pkg.amount_inr, pkg.coins, order.id, now, now);

    res.json({
      payment_id: id,
      razorpay_order_id: order.id,
      razorpay_key_id: KEY_ID,
      amount_inr: pkg.amount_inr,
      coins: pkg.coins,
      user_name: req.user.username,
      user_email: req.user.email
    });
  } catch (err) {
    console.error('Razorpay order creation failed:', err);
    res.status(502).json({ error: 'order_creation_failed' });
  }
});

// STEP 2 - Client-side verification, called from Razorpay Checkout's success
// handler. Coins are only credited after the HMAC signature check passes -
// a forged/fake "success" from the browser can never pass this check.
router.post('/verify', requireAuth, (req, res) => {
  const { payment_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const payment = db.prepare('SELECT * FROM payments WHERE id = ? AND user_id = ?').get(payment_id, req.user.id);
  if (!payment) return res.status(404).json({ error: 'payment_not_found' });

  const expectedSignature = crypto
    .createHmac('sha256', KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    db.prepare(`UPDATE payments SET payment_status = 'failed', updated_at = ? WHERE id = ?`).run(Date.now(), payment.id);
    return res.status(402).json({ error: 'signature_mismatch' });
  }

  const result = creditPaymentIfPending(payment.id, razorpay_payment_id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ ok: true, coins_added: payment.coins, new_balance: updated.spendable_coins, already_credited: result.already });
});

router.get('/history', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json({ payments: rows });
});

// STEP 3 (belt-and-suspenders) - Razorpay server-to-server webhook. This is
// what makes crediting truly automatic for every user even if their browser
// closes/crashes right after paying, before the client-side /verify call
// fires. Mounted with a raw body parser in index.js (signature needs the
// exact raw bytes), so this export is a plain handler, not a router.
function webhookHandler(req, res) {
  if (!WEBHOOK_SECRET) {
    console.warn('Received Razorpay webhook but RAZORPAY_WEBHOOK_SECRET is not set - ignoring.');
    return res.status(400).send('webhook_not_configured');
  }
  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest('hex');
  if (signature !== expected) {
    return res.status(400).send('invalid_signature');
  }

  const event = JSON.parse(req.body.toString('utf8'));
  if (event.event === 'payment.captured' || event.event === 'order.paid') {
    const orderId = event.payload?.payment?.entity?.order_id || event.payload?.order?.entity?.id;
    const paymentEntityId = event.payload?.payment?.entity?.id;
    if (orderId) {
      const payment = db.prepare('SELECT * FROM payments WHERE provider_order_id = ?').get(orderId);
      if (payment) creditPaymentIfPending(payment.id, paymentEntityId || 'webhook');
    }
  }
  res.json({ received: true });
}

module.exports = { router, webhookHandler };
