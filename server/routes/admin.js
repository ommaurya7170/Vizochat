const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

module.exports = function (getOnlineCount) {
  const router = express.Router();
  router.use(requireAuth, requireAdmin);

  router.get('/stats', (req, res) => {
    const totalUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const bannedUsers = db.prepare(`SELECT id, username, email, ban_started_at, ban_expires_at FROM users WHERE account_status = 'banned'`).all();
    const totalEarned = db.prepare('SELECT COALESCE(SUM(earned_coins),0) s FROM users').get().s;
    const totalBought = db.prepare(`SELECT COALESCE(SUM(coins),0) s FROM payments WHERE payment_status = 'success'`).get().s;

    res.json({
      total_users: totalUsers,
      online_users: getOnlineCount(),
      banned_users: bannedUsers,
      total_earned_coins: totalEarned,
      total_bought_coins: totalBought
    });
  });

  router.get('/user/:id', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'not_found' });
    const transactions = db.prepare('SELECT * FROM coin_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(user.id);
    const reportsAgainst = db.prepare('SELECT * FROM reports WHERE reported_user_id = ? ORDER BY created_at DESC LIMIT 50').all(user.id);
    const payments = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(user.id);
    res.json({ user, transactions, reportsAgainst, payments });
  });

  router.get('/users/search', (req, res) => {
    const q = `%${req.query.q || ''}%`;
    const rows = db.prepare('SELECT id, username, email, account_status FROM users WHERE id LIKE ? OR username LIKE ? OR email LIKE ? LIMIT 25')
      .all(q, q, q);
    res.json({ users: rows });
  });

  router.post('/user/:id/ban', (req, res) => {
    const now = Date.now();
    const days = Number(req.body.days || process.env.BAN_DURATION_DAYS || 21);
    db.prepare(`UPDATE users SET account_status = 'banned', ban_started_at = ?, ban_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now + days * 86400000, now, req.params.id);
    res.json({ ok: true });
  });

  router.post('/user/:id/unban', (req, res) => {
    const now = Date.now();
    db.prepare(`UPDATE users SET account_status = 'active', ban_started_at = NULL, ban_expires_at = NULL, updated_at = ? WHERE id = ?`)
      .run(now, req.params.id);
    res.json({ ok: true });
  });

  router.get('/errors', (req, res) => {
    const rows = db.prepare('SELECT * FROM error_logs ORDER BY created_at DESC LIMIT 200').all();
    res.json({ errors: rows });
  });

  return router;
};
