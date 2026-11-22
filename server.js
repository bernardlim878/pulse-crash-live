import http from 'node:http';
import { randomBytes, randomInt, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const publicDir = resolve(baseDir, 'public');
const port = Number(process.env.PORT || 3000);
const roomCode = (process.env.ROOM_CODE || 'MOON26').replace(/[^A-Z0-9-]/gi, '').slice(0, 20).toUpperCase();
const hostPasscode = process.env.HOST_PASSCODE || '';

if (hostPasscode && hostPasscode.length < 16) {
  console.error('Set HOST_PASSCODE to a private value of at least 16 characters before starting the room.');
  process.exit(1);
}

const room = {
  name: process.env.ROOM_NAME || 'Moonlight Lounge',
  code: roomCode,
  hostCoins: 12000,
  inviteOpen: true,
  pauseAfterRound: false,
  players: new Map(),
  requests: [],
  history: [1.68, 2.32, 2.04, 4.59, 1.34, 2.05, 4.52, 1.54],
  nextRequestId: 1,
  round: null
};

const hostSessions = new Set();
const guestSessions = new Map();
const streams = new Set();
const loginFailures = new Map();

const speedFor = (pool) => Math.min(3, 1 + Math.max(0, pool) / 4000);
const multiplierAt = (roundState, now = Date.now()) => {
  if (!roundState.startedAt) return 1;
  return Math.exp((now - roundState.startedAt) / 1000 * 0.15 * roundState.speedFactor);
};

function newRound() {
  const id = (room.round?.id || 65625) + 1;
  room.round = {
    id,
    phase: room.pauseAfterRound ? 'paused' : 'countdown',
    countdownEndsAt: room.pauseAfterRound ? null : Date.now() + 8000,
    crashAt: randomInt(105, 500) / 100,
    startedAt: null,
    speedFactor: 1,
    multiplier: 1,
    crashedAt: null,
    pool: 0,
    nextRoundAt: null
  };
  for (const player of room.players.values()) {
    player.bet = null;
    player.cashoutAt = null;
    player.autoCashout = null;
    player.lastResult = null;
  }
  broadcast();
}

function pendingPool() {
  let total = 0;
  for (const player of room.players.values()) if (player.bet?.roundId === room.round?.id) total += player.bet.amount;
  return total;
}

function publicState(isHost, ownPlayerId) {
  const current = room.round;
  const now = Date.now();
  const liveMultiplier = current?.phase === 'running' ? multiplierAt(current, now) : (current?.multiplier || 1);
  const pool = current?.phase === 'running' ? current.pool : pendingPool();
  return {
    room: { name: room.name, code: room.code, inviteOpen: room.inviteOpen },
    phase: current?.phase || 'countdown',
    roundId: current?.id || 0,
    secondsLeft: current?.countdownEndsAt ? Math.max(0, (current.countdownEndsAt - now) / 1000) : null,
    multiplier: Number(liveMultiplier.toFixed(2)),
    crashedAt: current?.phase === 'ended' ? current.crashedAt : null,
    pool,
    speedFactor: Number(speedFor(pool).toFixed(2)),
    roundSpeed: current?.phase === 'running' ? current.speedFactor : null,
    autoPaused: room.pauseAfterRound,
    hostCoins: isHost ? room.hostCoins : null,
    pendingRequests: isHost ? room.requests.filter((item) => item.status === 'pending') : undefined,
    pendingCount: room.requests.filter((item) => item.status === 'pending').length,
    myRequest: ownPlayerId ? [...room.requests].reverse().find((item) => item.playerId === ownPlayerId) || null : null,
    history: room.history.slice(-8).reverse(),
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      coins: player.coins,
      bet: player.bet?.roundId === current?.id ? player.bet.amount : 0,
      cashoutAt: player.cashoutAt,
      lastResult: player.lastResult,
      isYou: player.id === ownPlayerId
    }))
  };
}

function streamData(client) {
  const data = JSON.stringify({ ...publicState(client.isHost, client.playerId), isHost: client.isHost, playerId: client.playerId });
  client.response.write(`event: room\ndata: ${data}\n\n`);
}

function broadcast() {
  for (const client of streams) {
    try { streamData(client); } catch { streams.delete(client); }
  }
}

function tick() {
  const current = room.round;
  if (!current) return;
  const now = Date.now();
  if (current.phase === 'countdown' && current.countdownEndsAt <= now) {
    current.pool = pendingPool();
    current.speedFactor = speedFor(current.pool);
    current.phase = 'running';
    current.startedAt = now;
    current.multiplier = 1;
    broadcast();
    return;
  }
  if (current.phase === 'countdown' && now - (current.lastBroadcastAt || 0) >= 500) {
    current.lastBroadcastAt = now;
    broadcast();
    return;
  }
  if (current.phase === 'running') {
    current.multiplier = multiplierAt(current, now);
    for (const player of room.players.values()) {
      if (player.bet?.roundId !== current.id || player.cashoutAt || !player.autoCashout) continue;
      if (player.autoCashout < current.crashAt && current.multiplier >= player.autoCashout) {
        player.cashoutAt = player.autoCashout;
        const score = Math.floor(player.bet.amount * player.autoCashout);
        player.coins += score;
        player.lastResult = `Collected ${score} at ${player.autoCashout.toFixed(2)}×`;
      }
    }
    if (current.multiplier >= current.crashAt) {
      current.phase = 'ended';
      current.crashedAt = current.crashAt;
      current.multiplier = current.crashAt;
      room.history.push(current.crashAt);
      room.history = room.history.slice(-20);
      current.nextRoundAt = now + 3500;
      broadcast();
      return;
    }
    if (now - (current.lastBroadcastAt || 0) >= 120) {
      current.lastBroadcastAt = now;
      broadcast();
    }
    return;
  }
  if (current.phase === 'ended' && !room.pauseAfterRound && current.nextRoundAt <= now) newRound();
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const split = part.indexOf('=');
    return [part.slice(0, split), decodeURIComponent(part.slice(split + 1))];
  }));
}

function identify(req) {
  const jar = cookies(req);
  const hostToken = jar.pulse_host;
  const guestToken = jar.pulse_player;
  const isHost = !!hostToken && hostSessions.has(hostToken);
  const playerId = guestToken ? guestSessions.get(guestToken) : null;
  return { isHost, playerId: playerId || null, player: playerId ? room.players.get(playerId) : null };
}

function cookieOptions(req) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? '; Secure' : ''}`;
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16_000) {
        reject(new Error('Request is too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolveBody(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function cleanName(value) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 24);
}

function sameSecret(candidate) {
  const value = Buffer.from(String(candidate || ''));
  const expected = Buffer.from(hostPasscode);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  try { return new URL(origin).host === forwardedHost; } catch { return false; }
}

function requireHost(req, res) {
  if (!identify(req).isHost) {
    json(res, 401, { error: 'Host sign-in required' });
    return false;
  }
  return true;
}

function requirePlayer(req, res) {
  const identity = identify(req);
  if (!identity.player) {
    json(res, 401, { error: 'Join the room first' });
    return null;
  }
  return identity.player;
}

async function serveStatic(pathname, res) {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const target = resolve(publicDir, requested);
  const relativeTarget = relative(publicDir, target);
  if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) return json(res, 403, { error: 'Not allowed' });
  try {
    const content = await readFile(target);
    const type = ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' })[extname(target)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
  } catch {
    json(res, 404, { error: 'Page not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const identity = identify(req);
    return json(res, 200, { ...publicState(identity.isHost, identity.playerId), isHost: identity.isHost, playerId: identity.playerId, joined: !!identity.player });
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    const identity = identify(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const client = { response: res, isHost: identity.isHost, playerId: identity.playerId };
    streams.add(client);
    streamData(client);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); streams.delete(client); });
    return;
  }
  if (req.method === 'GET') return serveStatic(url.pathname, res);
  if (!originAllowed(req)) return json(res, 403, { error: 'Request origin rejected' });
  let body;
  try { body = await readJson(req); } catch (error) { return json(res, 400, { error: error.message }); }

  if (req.method === 'POST' && url.pathname === '/api/host/login') {
    if (!hostPasscode) return json(res, 503, { error: 'Host sign-in is not configured yet. Set HOST_PASSCODE privately in the server settings.' });
    const ip = req.socket.remoteAddress || 'unknown';
    const failed = loginFailures.get(ip) || { count: 0, blockedUntil: 0 };
    if (Date.now() < failed.blockedUntil) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    if (!sameSecret(body.passcode)) {
      failed.count += 1;
      if (failed.count >= 6) { failed.count = 0; failed.blockedUntil = Date.now() + 10 * 60_000; }
      loginFailures.set(ip, failed);
      return json(res, 401, { error: 'That host passcode did not match.' });
    }
    loginFailures.delete(ip);
    const token = randomBytes(32).toString('hex');
    hostSessions.add(token);
    return json(res, 200, { ok: true }, { 'Set-Cookie': `pulse_host=${token}; ${cookieOptions(req)}` });
  }
  if (req.method === 'POST' && url.pathname === '/api/host/logout') {
    const token = cookies(req).pulse_host;
    if (token) hostSessions.delete(token);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'pulse_host=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
  }
  if (req.method === 'POST' && url.pathname === '/api/join') {
    if (!room.inviteOpen) return json(res, 403, { error: 'The host has paused room invites.' });
    if (String(body.roomCode || '').toUpperCase() !== room.code) return json(res, 404, { error: 'That room code was not found.' });
    const name = cleanName(body.name);
    if (name.length < 2) return json(res, 400, { error: 'Choose a name with at least two characters.' });
    const id = randomUUID();
    const player = { id, name, coins: 1200, bet: null, cashoutAt: null, autoCashout: null, lastResult: null };
    room.players.set(id, player);
    const token = randomBytes(32).toString('hex');
    guestSessions.set(token, id);
    broadcast();
    return json(res, 200, { ok: true, playerId: id }, { 'Set-Cookie': `pulse_player=${token}; ${cookieOptions(req)}` });
  }
  if (req.method === 'POST' && url.pathname === '/api/bet') {
    const player = requirePlayer(req, res);
    if (!player) return;
    const amount = Math.floor(Number(body.amount));
    if (room.round.phase !== 'countdown') return json(res, 409, { error: 'Bets are closed for this round.' });
    if (!Number.isFinite(amount) || amount < 1 || amount > player.coins) return json(res, 400, { error: 'Enter an amount within your play coin balance.' });
    if (player.bet?.roundId === room.round.id) return json(res, 409, { error: 'You already joined this round.' });
    player.coins -= amount;
    const autoCashout = Number(body.autoCashout);
    player.bet = { roundId: room.round.id, amount };
    player.autoCashout = Number.isFinite(autoCashout) && autoCashout >= 1.01 && autoCashout <= 100 ? Number(autoCashout.toFixed(2)) : null;
    player.cashoutAt = null;
    broadcast();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/cashout') {
    const player = requirePlayer(req, res);
    if (!player) return;
    if (room.round.phase !== 'running' || player.bet?.roundId !== room.round.id || player.cashoutAt) return json(res, 409, { error: 'There is no active bet to collect.' });
    const multiplier = multiplierAt(room.round);
    if (multiplier >= room.round.crashAt) return json(res, 409, { error: 'The round has ended.' });
    const score = Math.floor(player.bet.amount * multiplier);
    player.cashoutAt = Number(multiplier.toFixed(2));
    player.autoCashout = null;
    player.coins += score;
    player.lastResult = `Collected ${score} at ${player.cashoutAt.toFixed(2)}×`;
    broadcast();
    return json(res, 200, { ok: true, score, multiplier: player.cashoutAt });
  }
  if (req.method === 'POST' && url.pathname === '/api/coin-request') {
    const player = requirePlayer(req, res);
    if (!player) return;
    const amount = Math.floor(Number(body.amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > 5000) return json(res, 400, { error: 'Request between 1 and 5,000 play coins.' });
    if (room.requests.some((item) => item.playerId === player.id && item.status === 'pending')) return json(res, 409, { error: 'You already have a request waiting for the host.' });
    room.requests.push({ id: room.nextRequestId++, playerId: player.id, playerName: player.name, amount, status: 'pending', createdAt: Date.now() });
    broadcast();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/host/request-decision') {
    if (!requireHost(req, res)) return;
    const request = room.requests.find((item) => item.id === Number(body.requestId) && item.status === 'pending');
    if (!request) return json(res, 404, { error: 'That request is no longer pending.' });
    const decision = body.decision;
    if (decision === 'grant') {
      if (room.hostCoins < request.amount) return json(res, 409, { error: 'The room coin reserve is too low.' });
      const player = room.players.get(request.playerId);
      if (!player) return json(res, 404, { error: 'That player is no longer in the room.' });
      room.hostCoins -= request.amount;
      player.coins += request.amount;
      request.status = 'granted';
    } else if (decision === 'decline') {
      request.status = 'declined';
    } else {
      return json(res, 400, { error: 'Choose grant or decline.' });
    }
    broadcast();
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/host/pause') {
    if (!requireHost(req, res)) return;
    room.pauseAfterRound = !room.pauseAfterRound;
    if (!room.pauseAfterRound && ['paused','ended'].includes(room.round.phase)) newRound();
    else broadcast();
    return json(res, 200, { ok: true, pauseAfterRound: room.pauseAfterRound });
  }
  if (req.method === 'POST' && url.pathname === '/api/host/invite-access') {
    if (!requireHost(req, res)) return;
    room.inviteOpen = !room.inviteOpen;
    broadcast();
    return json(res, 200, { ok: true, inviteOpen: room.inviteOpen });
  }
  json(res, 404, { error: 'Action not found.' });
});

newRound();
setInterval(tick, 50);
server.listen(port, '0.0.0.0', () => console.log(`Pulse Crash is listening on port ${port}; room code ${room.code}.`));

