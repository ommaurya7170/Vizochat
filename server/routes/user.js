const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { publicUser } = require('./auth');

const router = express.Router();

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/logout', requireAuth, (req, res) => {
  // Stateless JWT: real invalidation would use a token blacklist / short expiry + refresh.
  res.json({ ok: true });
});

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// GET current daily task status
router.get('/daily-task', requireAuth, (req, res) => {
  const date = todayUTC();
  const existing = db.prepare('SELECT * FROM daily_tasks WHERE user_id = ? AND task_date = ?').get(req.user.id, date);
  res.json({
    claimed_today: !!existing,
    reward_coins: 25,
    task_name: 'Write / Submit: vizochat.online'
  });
});

// POST claim daily task reward - server-side date + uniqueness enforced by UNIQUE(user_id, task_date)
router.post('/daily-task/claim', requireAuth, (req, res) => {
  const date = todayUTC();
  const now = Date.now();

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM daily_tasks WHERE user_id = ? AND task_date = ?').get(req.user.id, date);
    if (existing) {
      const err = new Error('already_claimed_today');
      err.code = 'ALREADY_CLAIMED';
      throw err;
    }
    const reward = 25;
    db.prepare(`INSERT INTO daily_tasks (id, user_id, task_date, task_name, completed_at, reward_coins)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(uuid(), req.user.id, date, 'Write / Submit: vizochat.online', now, reward);

    db.prepare('UPDATE users SET spendable_coins = spendable_coins + ?, updated_at = ? WHERE id = ?')
      .run(reward, now, req.user.id);

    db.prepare(`INSERT INTO coin_transactions (id, user_id, type, amount, source, balance_type, status, created_at)
                VALUES (?, ?, 'credit', ?, 'daily_task', 'spendable', 'completed', ?)`)
      .run(uuid(), req.user.id, reward, now);

    return reward;
  });

  try {
    const reward = tx();
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ ok: true, reward_coins: reward, new_balance: updated.spendable_coins });
  } catch (err) {
    if (err.code === 'ALREADY_CLAIMED') {
      return res.status(409).json({ error: 'already_claimed_today' });
    }
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Transaction history (coins) - for Earn Coin / Remain Coin pages
router.get('/transactions', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM coin_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(req.user.id);
  res.json({ transactions: rows });
});

module.exports = router;
