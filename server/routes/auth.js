const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const db = require('../db');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

let googleClient = null;
if (GOOGLE_CLIENT_ID) {
  const { OAuth2Client } = require('google-auth-library');
  googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
}

function issueToken(user) {
  return jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
}

function findOrCreateUser({ google_id, username, email, profile_image }) {
  let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(google_id);
  const now = Date.now();
  if (!user) {
    user = {
      id: uuid(),
      google_id,
      username,
      email,
      profile_image,
      spendable_coins: 0,
      earned_coins: 0,
      account_status: 'active',
      ban_started_at: null,
      ban_expires_at: null,
      is_admin: 0,
      created_at: now,
      updated_at: now
    };
    db.prepare(`INSERT INTO users
      (id, google_id, username, email, profile_image, spendable_coins, earned_coins, account_status, ban_started_at, ban_expires_at, is_admin, created_at, updated_at)
      VALUES (@id, @google_id, @username, @email, @profile_image, @spendable_coins, @earned_coins, @account_status, @ban_started_at, @ban_expires_at, @is_admin, @created_at, @updated_at)`
    ).run(user);
  } else {
    // Keep profile info fresh on every login (name/photo can change on Google's side).
    db.prepare('UPDATE users SET username = ?, email = ?, profile_image = ?, updated_at = ? WHERE id = ?')
      .run(username, email, profile_image, now, user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }
  return user;
}

// Public - the client fetches this at load time so the Google Client ID
// never has to be hardcoded/duplicated in the frontend source.
router.get('/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID, googleConfigured: !!googleClient });
});

// POST /api/auth/google  { id_token }
// Verifies the Google ID token server-side. Never trust a user object sent from the client.
router.post('/google', async (req, res) => {
  try {
    if (!googleClient) {
      return res.status(400).json({ error: 'google_oauth_not_configured', message: 'Set GOOGLE_CLIENT_ID in server/.env and restart the server.' });
    }
    const { id_token } = req.body;
    if (!id_token) return res.status(400).json({ error: 'id_token required' });

    const ticket = await googleClient.verifyIdToken({ idToken: id_token, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload.email_verified) {
      return res.status(401).json({ error: 'email_not_verified' });
    }

    const user = findOrCreateUser({
      google_id: payload.sub,
      username: payload.name || payload.email.split('@')[0],
      email: payload.email,
      profile_image: payload.picture
    });

    const token = issueToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('Google auth failed:', err.message);
    res.status(401).json({ error: 'google_verification_failed' });
  }
});

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    profile_image: u.profile_image,
    spendable_coins: u.spendable_coins,
    earned_coins: u.earned_coins,
    account_status: u.account_status,
    ban_expires_at: u.ban_expires_at,
    is_admin: !!u.is_admin
  };
}

module.exports = { router, publicUser };
