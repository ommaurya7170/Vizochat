const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const EVIDENCE_DIR = path.join(__dirname, '..', 'uploads', 'evidence');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, EVIDENCE_DIR),
  filename: (req, file, cb) => cb(null, uuid() + path.extname(file.originalname || '.webm'))
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

const WINDOW_MIN = Number(process.env.REPORT_WINDOW_MINUTES || 60);
const THRESHOLD = Number(process.env.REPORT_BAN_THRESHOLD || 5);
const BAN_DAYS = Number(process.env.BAN_DURATION_DAYS || 21);

function applyAutoBanIfNeeded(reportedUserId) {
  const since = Date.now() - WINDOW_MIN * 60 * 1000;
  const { count } = db.prepare(
    `SELECT COUNT(DISTINCT reporter_id) as count FROM reports
     WHERE reported_user_id = ? AND created_at >= ? AND status != 'dismissed'`
  ).get(reportedUserId, since);

  if (count >= THRESHOLD) {
    const now = Date.now();
    const expires = now + BAN_DAYS * 24 * 60 * 60 * 1000;
    db.prepare(`UPDATE users SET account_status = 'banned', ban_started_at = ?, ban_expires_at = ?, updated_at = ? WHERE id = ? AND account_status != 'banned'`)
      .run(now, expires, now, reportedUserId);
    return { banned: true, ban_expires_at: expires };
  }
  return { banned: false };
}

// POST /api/reports  (multipart: evidence file field "clip", plus reported_user_id, reason, session_id)
// Evidence is stored privately on the server filesystem - never served publicly.
router.post('/', requireAuth, upload.single('clip'), (req, res) => {
  const { reported_user_id, reason, session_id } = req.body;
  if (!reported_user_id) return res.status(400).json({ error: 'reported_user_id required' });
  if (reported_user_id === req.user.id) return res.status(400).json({ error: 'cannot_report_self' });

  // Prevent duplicate/spam report from same reporter against same person for same session.
  const dup = db.prepare(
    `SELECT id FROM reports WHERE reporter_id = ? AND reported_user_id = ? AND (session_id = ? OR session_id IS NULL) 
     AND created_at >= ?`
  ).get(req.user.id, reported_user_id, session_id || null, Date.now() - 10 * 60 * 1000);
  if (dup) return res.status(409).json({ error: 'duplicate_report' });

  const id = uuid();
  const now = Date.now();
  const evidencePath = req.file ? path.join('evidence', req.file.filename) : null;

  db.prepare(`INSERT INTO reports (id, reporter_id, reported_user_id, session_id, reason, evidence_url, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'valid', ?)`)
    .run(id, req.user.id, reported_user_id, session_id || null, reason || null, evidencePath, now);

  const banResult = applyAutoBanIfNeeded(reported_user_id);

  res.json({ ok: true, report_id: id, ...banResult });
});

module.exports = router;
