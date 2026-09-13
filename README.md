# VizoChat.online — Full-Stack P2P Video Chat with Coin Economy

A mobile-first, dark-navy/neon-cyan glassmorphism social video chat app with a
Spendable/Earned coin economy, gift system, random P2P matchmaking, in-call
text chat, reporting + auto-ban, and an admin panel.

## What's implemented

✅ **Real Google Sign-In** — no guest/demo login anymore. The login page
fetches your Google Client ID from the server (`GET /api/auth/config`) and
renders Google's own Sign-In button. The server verifies every ID token with
`google-auth-library` before creating a session — nothing from the frontend is
trusted.

✅ **Real Razorpay payments, auto-credited for every user** — `Buy Coins`
opens the actual Razorpay Checkout widget. Coins are added automatically
through two independent, idempotent paths so no purchase is ever missed:
1. Client-side: after checkout succeeds, the browser calls `/api/payments/verify`,
   which checks the HMAC signature Razorpay returns before crediting.
2. Server-side webhook: Razorpay also calls `/api/payments/webhook` directly
   from its own servers (signature-checked with `RAZORPAY_WEBHOOK_SECRET`), so
   coins still land even if the user's browser closes right after paying.

Both paths credit through the same `creditPaymentIfPending()` function, which
checks `payment_status` first — so a payment can never be credited twice.

✅ **Fixed the "stuck spinner on one side" bug** — the old code hid the
connecting animation immediately when a match was found, and dropped any
WebRTC signal that arrived before the peer connection object existed. Now:
- Incoming signals are queued and flushed once the peer connection is ready
  (no more dropped offers).
- The connecting animation only disappears once a live video track actually
  arrives (`ontrack`), so both sides transition at the moment they're truly
  connected — not optimistically.
- If a match can't connect within 15 seconds, or ICE reports
  `failed`/`disconnected`, the app automatically retries with someone new
  instead of leaving you stuck.

✅ **Faster, smoother connections** — added a public TURN relay (Metered's
Open Relay Project) alongside STUN, `iceCandidatePoolSize`, and
`bundlePolicy: 'max-bundle'` so calls establish faster and succeed across more
mobile/carrier NATs. Camera capture now requests a moderate 640×480/24fps
profile instead of default-max resolution, which is the main cause of laggy
video on average uplinks.

✅ **Working Chat button** — real in-call text messaging over a Socket.io
event (`chat_message`), scoped to the current room, with a chat panel UI.

✅ **Tuned for ~500 concurrent users on one server**:
- `compression` middleware + 1-hour static asset caching
- `express-rate-limit` on all `/api/*` routes so one abusive client can't
  starve everyone else
- Removed a broadcast-storm bug where every connect/disconnect emitted to
  *all* connected sockets (O(n²) at scale) — the admin panel now polls
  `/api/admin/stats` over plain HTTP instead
- SQLite in WAL mode (concurrent reads don't block writes); gift countdown
  ticks are computed server-side per-room and never hit the database — only
  the start and settlement of a gift write to disk
- Socket.io `pingTimeout`/`pingInterval` tuned for a mostly-idle-between-events
  workload (matchmaking + gift ticks + occasional chat)

## Setup

```bash
cd server
npm install
cp .env.example .env      # fill in the values below
npm start
```

### 1. Google OAuth (required — there is no other way to log in now)
1. Go to https://console.cloud.google.com/apis/credentials
2. Create an OAuth 2.0 Client ID (type: Web application)
3. Add Authorized JavaScript origins: your real domain, and
   `http://localhost:4000` for local testing
4. Put the Client ID in `server/.env` as `GOOGLE_CLIENT_ID`

### 2. Razorpay (required for Buy Coins to work)
1. Sign up at https://dashboard.razorpay.com/ (Test mode is free — no real
   money needed to try the full flow end-to-end)
2. Copy your Test **Key ID** and **Key Secret** into `server/.env` as
   `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`
3. In the Razorpay Dashboard, create a Webhook pointing to
   `https://yourdomain.com/api/payments/webhook` for the `payment.captured`
   event, and put its secret in `RAZORPAY_WEBHOOK_SECRET`
4. Test card/UPI numbers for Razorpay's test mode are listed at
   https://razorpay.com/docs/payments/payments/test-card-upi-details/

Until both are configured, the login page shows a clear setup message instead
of silently failing, and Buy Coins shows a setup message instead of a fake
"payment gateway not configured" 400 response.

## Making yourself an admin

After logging in once with your real Google account:

```bash
cd server
node make-admin.js you@example.com
```

Then visit `/admin.html` while logged in as that account.

## Scaling past ~500 concurrent users

The tuning above comfortably handles several hundred concurrent users on a
single small-to-medium VPS. To go further:
- Put nginx (or similar) in front as a reverse proxy/TLS terminator
- Run the Node process under PM2 in cluster mode, and add the
  `socket.io-redis-adapter` so matchmaking/signaling events are shared across
  worker processes (right now matchmaking state is in-memory in one process)
- Move report evidence uploads from local disk (`server/uploads/evidence/`) to
  a private S3-style bucket
- Get a dedicated TURN server (coturn on your own box, or a paid
  Twilio/Metered plan) — the free Open Relay Project used by default is
  rate-limited and not meant for production-scale traffic

## Project structure

```
vizochat/
  server/
    index.js              entry point (express + socket.io + cron for ban expiry)
    db.js                  SQLite schema
    routes/                auth (Google), user, coins, payments (Razorpay), reports, admin
    middleware/             JWT auth + ban check
    sockets/index.js        matchmaking, WebRTC signaling relay, gift timer, chat relay
  client/
    index.html              Google Sign-In login
    home.html, profile.html, earn.html, remain.html, help.html, camera.html
    video-chat.html + js/videochat.js   main P2P video screen + chat + gifts + report
    admin.html + js/admin.js             admin panel
    css/style.css                        shared neon/glass theme
```

## Coin rules implemented

- **Spendable coins**: purchases + daily task rewards → can be used for gifts.
- **Earned coins**: only credited from gifts received → cannot be spent on
  gifts, cannot be transferred, only for withdrawal.
- Gift flow: sender's coins are reserved immediately, then consumed at
  1 coin/second while the call continues. On swipe/disconnect/report/zero, the
  server (not the client) computes consumed vs. unused coins, credits the
  receiver's earned balance, and refunds unused coins to the sender — all in
  one atomic DB transaction.

## Known simplifications (documented, not hidden)

- Matchmaking/gift state is in-memory on one process — see the scaling note
  above for going beyond a single server.
- JWT sessions aren't revocable server-side (no blacklist) — fine for most
  apps, but note it if you need instant force-logout.
- Report evidence clips are saved to local disk by default — move to private
  cloud storage before going to production.
