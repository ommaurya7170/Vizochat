const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

// In-memory runtime state (fine for a single server instance / demo scale;
// for multi-instance production, move this to Redis).
const onlineUsers = new Map();   // userId -> socketId
const waitingQueue = [];         // [userId, ...]
const rooms = new Map();         // roomId -> { a: userId, b: userId }
const userRoom = new Map();      // userId -> roomId
const activeGifts = new Map();   // roomId -> { intervalId, giftSessionId, senderId, receiverId, remaining, startedAt }

function getOnlineCount() {
  return onlineUsers.size;
}

function authenticateSocket(socket, next) {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!user) return next(new Error('user_not_found'));
    socket.user = user;
    next();
  } catch (err) {
    next(new Error('unauthorized'));
  }
}

function refreshUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function endGiftSession(io, roomId, reason) {
  const g = activeGifts.get(roomId);
  if (!g) return;
  clearInterval(g.intervalId);
  activeGifts.delete(roomId);

  const elapsedSeconds = Math.min(g.giftAmount, Math.floor((Date.now() - g.startedAt) / 1000));
  const consumed = elapsedSeconds;
  const unused = g.giftAmount - consumed;
  const now = Date.now();

  const sender = refreshUser(g.senderId);
  const receiver = refreshUser(g.receiverId);
  if (!sender || !receiver) return;

  const tx = db.transaction(() => {
    if (unused > 0) {
      db.prepare('UPDATE users SET spendable_coins = spendable_coins + ?, updated_at = ? WHERE id = ?')
        .run(unused, now, sender.id);
      db.prepare(`INSERT INTO coin_transactions (id, user_id, type, amount, source, balance_type, status, created_at)
                  VALUES (?, ?, 'credit', ?, 'gift_refund', 'spendable', 'completed', ?)`)
        .run(uuid(), sender.id, unused, now);
    }
    if (consumed > 0) {
      db.prepare('UPDATE users SET earned_coins = earned_coins + ?, updated_at = ? WHERE id = ?')
        .run(consumed, now, receiver.id);
      db.prepare(`INSERT INTO coin_transactions (id, user_id, type, amount, source, balance_type, status, created_at)
                  VALUES (?, ?, 'credit', ?, 'gift_received', 'earned', 'completed', ?)`)
        .run(uuid(), receiver.id, consumed, now);
    }
    db.prepare(`UPDATE gift_sessions SET ended_at = ?, consumed_seconds = ?, consumed_coins = ?, unused_coins = ?,
                status = 'completed', sender_balance_after = ?, receiver_earning_after = ? WHERE id = ?`)
      .run(now, elapsedSeconds, consumed, unused,
        sender.spendable_coins + unused, receiver.earned_coins + consumed, g.giftSessionId);
  });
  tx();

  io.to(roomId).emit('gift_ended', { reason, consumed, unused, gift_session_id: g.giftSessionId });

  const updatedSender = refreshUser(sender.id);
  const updatedReceiver = refreshUser(receiver.id);
  io.to(g.senderSocketId).emit('balance_update', { spendable_coins: updatedSender.spendable_coins, earned_coins: updatedSender.earned_coins });
  io.to(g.receiverSocketId).emit('balance_update', { spendable_coins: updatedReceiver.spendable_coins, earned_coins: updatedReceiver.earned_coins });
}

function leaveRoom(io, socket, { rejoinQueue } = {}) {
  const roomId = userRoom.get(socket.user.id);
  if (!roomId) return;

  endGiftSession(io, roomId, 'session_ended');

  const room = rooms.get(roomId);
  if (room) {
    const otherId = room.a === socket.user.id ? room.b : room.a;
    userRoom.delete(otherId);
    userRoom.delete(socket.user.id);
    rooms.delete(roomId);

    const otherSocketId = onlineUsers.get(otherId);
    if (otherSocketId) {
      io.to(otherSocketId).emit('partner_left');
      io.sockets.sockets.get(otherSocketId)?.leave(roomId);
      if (rejoinQueue?.requeueOther) {
        enqueue(io, otherId);
      }
    }
  }
  socket.leave(roomId);
}

function tryMatch(io) {
  while (waitingQueue.length >= 2) {
    const aId = waitingQueue.shift();
    const bId = waitingQueue.shift();
    const aSocketId = onlineUsers.get(aId);
    const bSocketId = onlineUsers.get(bId);
    if (!aSocketId || !bSocketId) {
      // one disconnected while waiting - requeue the still-online one
      if (aSocketId) waitingQueue.unshift(aId);
      if (bSocketId) waitingQueue.unshift(bId);
      continue;
    }
    const roomId = uuid();
    rooms.set(roomId, { a: aId, b: bId });
    userRoom.set(aId, roomId);
    userRoom.set(bId, roomId);

    const aSocket = io.sockets.sockets.get(aSocketId);
    const bSocket = io.sockets.sockets.get(bSocketId);
    aSocket?.join(roomId);
    bSocket?.join(roomId);

    io.to(aSocketId).emit('matched', { roomId, initiator: true, peerId: bId });
    io.to(bSocketId).emit('matched', { roomId, initiator: false, peerId: aId });
  }
}

function enqueue(io, userId) {
  if (!waitingQueue.includes(userId) && !userRoom.has(userId)) {
    waitingQueue.push(userId);
  }
  tryMatch(io);
}

function dequeue(userId) {
  const idx = waitingQueue.indexOf(userId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function attachSocketHandlers(io) {
  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    const user = socket.user;
    onlineUsers.set(user.id, socket.id);
    // NOTE: we deliberately do NOT broadcast presence to every connected socket
    // here - at a few hundred concurrent users that turns into an O(n^2) message
    // storm on every connect/disconnect. The admin panel instead polls
    // GET /api/admin/stats periodically, which is O(1) per request.

    socket.on('find_match', () => {
      const fresh = refreshUser(user.id);
      if (fresh.account_status === 'banned') {
        socket.emit('banned', { ban_expires_at: fresh.ban_expires_at });
        return;
      }
      enqueue(io, user.id);
      socket.emit('searching');
    });

    socket.on('cancel_search', () => dequeue(user.id));

    // WebRTC signaling relay (offer/answer/ICE candidates) - server never
    // inspects media, it just relays SDP/ICE between the two matched peers.
    socket.on('signal', ({ roomId, data }) => {
      socket.to(roomId).emit('signal', { data, from: user.id });
    });

    socket.on('swipe_next', () => {
      leaveRoom(io, socket, { requeueOther: true });
      enqueue(io, user.id);
      socket.emit('searching');
    });

    socket.on('leave_room', () => {
      leaveRoom(io, socket, { requeueOther: true });
    });

    // ---- In-call text chat ----
    socket.on('chat_message', ({ text }) => {
      const roomId = userRoom.get(user.id);
      if (!roomId || !text) return;
      const trimmed = String(text).slice(0, 500); // guard against huge payloads
      socket.to(roomId).emit('chat_message', { text: trimmed, from: user.id, at: Date.now() });
    });

    // ---- GIFT SYSTEM (server-authoritative) ----
    socket.on('send_gift', ({ amount }) => {
      const roomId = userRoom.get(user.id);
      if (!roomId) return socket.emit('gift_error', { error: 'not_in_a_call' });
      if (activeGifts.has(roomId)) return socket.emit('gift_error', { error: 'gift_already_active' });

      const validAmounts = [3, 29, 69, 149, 599, 999];
      if (!validAmounts.includes(amount)) return socket.emit('gift_error', { error: 'invalid_gift_amount' });

      const sender = refreshUser(user.id);
      if (sender.spendable_coins < amount) return socket.emit('gift_error', { error: 'insufficient_balance' });

      const room = rooms.get(roomId);
      const receiverId = room.a === user.id ? room.b : room.a;
      const receiverSocketId = onlineUsers.get(receiverId);
      if (!receiverSocketId) return socket.emit('gift_error', { error: 'partner_offline' });

      const now = Date.now();
      const giftSessionId = uuid();

      // Reserve the coins immediately (atomic debit) - this is the "reservation" step.
      const tx = db.transaction(() => {
        db.prepare('UPDATE users SET spendable_coins = spendable_coins - ?, updated_at = ? WHERE id = ?')
          .run(amount, now, sender.id);
        db.prepare(`INSERT INTO coin_transactions (id, user_id, type, amount, source, balance_type, status, created_at)
                    VALUES (?, ?, 'debit', ?, 'gift_sent', 'spendable', 'completed', ?)`)
          .run(uuid(), sender.id, amount, now);
        db.prepare(`INSERT INTO gift_sessions
          (id, sender_id, receiver_id, room_id, gift_amount, started_at, platform_fee, status, sender_balance_before, receiver_earning_before)
          VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`)
          .run(giftSessionId, sender.id, receiverId, roomId, amount, now, sender.spendable_coins, refreshUser(receiverId).earned_coins);
      });
      tx();

      const updatedSender = refreshUser(sender.id);
      socket.emit('balance_update', { spendable_coins: updatedSender.spendable_coins, earned_coins: updatedSender.earned_coins });

      let remaining = amount;
      const intervalId = setInterval(() => {
        remaining -= 1;
        io.to(roomId).emit('gift_tick', { remaining, gift_session_id: giftSessionId });
        if (remaining <= 0) {
          endGiftSession(io, roomId, 'completed');
        }
      }, 1000);

      activeGifts.set(roomId, {
        intervalId, giftSessionId, giftAmount: amount,
        senderId: sender.id, receiverId, startedAt: now,
        senderSocketId: socket.id, receiverSocketId
      });

      io.to(roomId).emit('gift_started', { amount, gift_session_id: giftSessionId, senderId: sender.id });
    });

    socket.on('disconnect', () => {
      onlineUsers.delete(user.id);
      dequeue(user.id);
      leaveRoom(io, socket, { requeueOther: true });
    });
  });
}

module.exports = { attachSocketHandlers, getOnlineCount };
