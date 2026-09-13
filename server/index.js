require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { v4: uuid } = require('uuid');

const db = require('./db');
const { router: authRouter } = require('./routes/auth');
const userRouter = require('./routes/user');
const coinsRouter = require('./routes/coins');
const { router: paymentsRouter, webhookHandler } = require('./routes/payments');
const reportsRouter = require('./routes/reports');
const adminRouterFactory = require('./routes/admin');
const { attachSocketHandlers, getOnlineCount } = require('./sockets/index');

const app = express();
const server = http.createServer(app);

// Socket.io tuned for a few hundred concurrent, mostly-idle-between-events
// connections (matchmaking + gift ticks + occasional chat messages).
// For >500 concurrent on a single box, put nginx in front (see README) and
// consider the socket.io-redis-adapter once you scale past one process.
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 20000,
  pingInterval: 25000,
  maxHttpBufferSize: 2 * 1024 * 1024, // 2MB - generous enough for report evidence chunks, small enough to resist abuse
  perMessageDeflate: { threshold: 1024 }
});

app.set('trust proxy', 1);
app.use(compression());
app.use(cors());

// Razorpay webhook needs the exact raw request bytes for signature
// verification, so it must be mounted BEFORE the global JSON body parser.
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookHandler);

app.use(express.json({ limit: '1mb' }));

// Basic abuse protection so a single client can't hammer the API and starve
// the other ~500 concurrent users. Tune the numbers to your real traffic.
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

// Serve the mobile-first client with long cache on static assets
app.use(express.static(path.join(__dirname, '..', 'client'), { maxAge: '1h' }));

app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/coins', coinsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/admin', adminRouterFactory(getOnlineCount));

attachSocketHandlers(io);

// Central error logger - captures unexpected server errors for the admin monitoring panel
app.use((err, req, res, next) => {
  try {
    db.prepare('INSERT INTO error_logs (id, message, stack, route, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), err.message, err.stack, req.originalUrl, Date.now());
  } catch (_) { /* ignore logging failure */ }
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

// Auto-restore expired 21-day bans every minute
setInterval(() => {
  const now = Date.now();
  db.prepare(`UPDATE users SET account_status = 'active', ban_started_at = NULL, ban_expires_at = NULL, updated_at = ?
              WHERE account_status = 'banned' AND ban_expires_at IS NOT NULL AND ban_expires_at <= ?`)
    .run(now, now);
}, 60 * 1000);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`VizoChat server running on http://localhost:${PORT}`);
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.warn('WARNING: GOOGLE_CLIENT_ID is not set - login will not work until you configure it in server/.env');
  }
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.warn('WARNING: RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET not set - Buy Coins will show a setup message until configured.');
  }
});
