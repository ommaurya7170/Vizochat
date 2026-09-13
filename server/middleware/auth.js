const jwt = require('jsonwebtoken');
const db = require('../db');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret_change_me');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!user) return res.status(401).json({ error: 'User not found' });

    // Always re-check ban status server-side, never trust the token alone.
    if (user.account_status === 'banned') {
      const now = Date.now();
      if (user.ban_expires_at && now >= user.ban_expires_at) {
        db.prepare(`UPDATE users SET account_status = 'active', ban_started_at = NULL, ban_expires_at = NULL, updated_at = ? WHERE id = ?`)
          .run(now, user.id);
        user.account_status = 'active';
      }
    }

    req.user = user; // full, trusted, server-side copy
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
