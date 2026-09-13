// db.js - SQLite database setup (better-sqlite3 is synchronous, fast, and
// gives us real transactions which we rely on for atomic coin operations).
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'vizochat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_id TEXT UNIQUE,
  username TEXT NOT NULL,
  email TEXT,
  profile_image TEXT,
  spendable_coins INTEGER NOT NULL DEFAULT 0,
  earned_coins INTEGER NOT NULL DEFAULT 0,
  account_status TEXT NOT NULL DEFAULT 'active', -- active | banned
  ban_started_at INTEGER,
  ban_expires_at INTEGER,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  task_date TEXT NOT NULL, -- YYYY-MM-DD (server date, UTC)
  task_name TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  reward_coins INTEGER NOT NULL,
  UNIQUE(user_id, task_date),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS coin_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,       -- credit | debit
  amount INTEGER NOT NULL,
  source TEXT NOT NULL,     -- purchase | daily_task | gift_sent | gift_received | gift_refund | admin_adjust
  balance_type TEXT NOT NULL, -- spendable | earned
  status TEXT NOT NULL DEFAULT 'completed',
  meta TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS gift_sessions (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  room_id TEXT,
  gift_amount INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  consumed_seconds INTEGER,
  consumed_coins INTEGER,
  unused_coins INTEGER,
  platform_fee INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active | completed | cancelled
  sender_balance_before INTEGER,
  sender_balance_after INTEGER,
  receiver_earning_before INTEGER,
  receiver_earning_after INTEGER,
  FOREIGN KEY(sender_id) REFERENCES users(id),
  FOREIGN KEY(receiver_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  reported_user_id TEXT NOT NULL,
  session_id TEXT,
  reason TEXT,
  evidence_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | valid | dismissed
  created_at INTEGER NOT NULL,
  FOREIGN KEY(reporter_id) REFERENCES users(id),
  FOREIGN KEY(reported_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  package_label TEXT NOT NULL,
  amount_inr INTEGER NOT NULL,
  coins INTEGER NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'pending', -- pending | success | failed
  provider_order_id TEXT,
  provider_transaction_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS error_logs (
  id TEXT PRIMARY KEY,
  message TEXT,
  stack TEXT,
  route TEXT,
  created_at INTEGER NOT NULL
);
`);

module.exports = db;
