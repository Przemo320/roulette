'use strict';
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { randomBytes, randomInt, randomUUID } = require('node:crypto');
const path = require('node:path');
const games = require('./games');
const passwords = require('./passwords');
const { fail } = games;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

async function transaction(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const v = await fn(c);
    await c.query('COMMIT');
    return v;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function getServerConfig(cOrPool) {
  const { rows } = await cOrPool.query('SELECT rng_settings, event_data FROM casino_config WHERE id=1');
  const row = rows[0] || { rng_settings: {}, event_data: {} };
  const ev = row.event_data || {};
  const isEventActive = Boolean(ev.title && Number(ev.expiresAt) > Date.now());
  return {
    rngSettings: row.rng_settings || {},
    event: {
      active: isEventActive,
      title: ev.title || '',
      description: ev.description || '',
      winMultiplier: isEventActive ? (Number(ev.winMultiplier) || 1.0) : 1.0,
      dailyBonus: isEventActive ? (Number(ev.dailyBonus) || 1000) : 1000,
      expiresAt: Number(ev.expiresAt) || 0,
      posterBase64: isEventActive ? (ev.posterBase64 || '') : ''
    }
  };
}

async function playerLock(c, nick) {
  const { rows } = await c.query('SELECT * FROM players WHERE nick=$1 FOR UPDATE', [nick]);
  if (!rows[0]) fail('Konto nie istnieje.', 401);
  return rows[0];
}

async function balance(c, p, delta) {
  const value = Number(p.credits) + delta;
  if (!Number.isSafeInteger(value) || value < 0 || value > 9_000_000_000_000) fail('Nieprawidłowe saldo.', 409);
  p.credits = value;
  await c.query('UPDATE players SET credits=$2,updated_at=NOW() WHERE nick=$1', [p.nick, value]);
}

async function bonus(c, p, bonusAmount = 1000) {
  if (p.last_bonus_date === today()) return false;
  await balance(c, p, bonusAmount);
  p.last_bonus_date = today();
  await c.query('UPDATE players SET last_bonus_date=$2 WHERE nick=$1', [p.nick, p.last_bonus_date]);
  return true;
}

async function persist(c, p, row) {
  if (row.status === 'active' && row.state.status === 'settled') await balance(c, p, row.state.payout);
  await c.query(
    `UPDATE casino_rounds SET state=$2,status=$3,payout=$4,
     settled_at=CASE WHEN $3='settled' THEN COALESCE(settled_at,NOW()) ELSE NULL END WHERE id=$1`,
    [row.id, row.state, row.state.status, row.state.payout]
  );
  row.status = row.state.status;
  row.payout = row.state.payout;
}

async function active(c, p) {
  const { rows } = await c.query("SELECT * FROM casino_rounds WHERE nick=$1 AND status='active' FOR UPDATE", [p.nick]);
  if (!rows[0]) return null;
  const row = rows[0];
  games.advance(row.state);
  await persist(c, p, row);
  return row.status === 'active' ? row : null;
}

function createApp(pool, options = {}) {
  const app = express();
  const publicUrl = (options.publicUrl || process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  app.disable('x-powered-by');
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 0));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'style-src': ["'self'", "'unsafe-inline'"],
        'upgrade-insecure-requests': publicUrl.startsWith('https:') ? [] : null
      }
    }
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', rateLimit({ windowMs: 60000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));
  const authLimit = rateLimit({
    windowMs: 15 * 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Za dużo prób. Spróbuj później.' }
  });

  app.get('/ping', (_, res) => res.type('text/plain').send('OK'));
  app.get('/', (_, res) => res.redirect('/activate/'));
  app.get('/health', async (_, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, version: 2 });
  });
  app.use('/activate', express.static(path.join(__dirname, '../public'), { index: 'index.html' }));

  app.post(['/sync', '/login'], (_, res) =>
    res.status(410).json({ ok: false, error: 'Zainstaluj Casino Wear v2. Stary protokół jest wyłączony.' })
  );

  // Publiczny odczyt i zapis konfiguracji losowości oraz Ewentu ze strony głównej
  app.get('/api/public/config', async (_, res) => {
    const cfg = await getServerConfig(pool);
    res.json({ ok: true, ...cfg });
  });

  app.post('/api/public/config', authLimit, async (req, res) => {
    const { rngSettings, event } = req.body || {};
    const current = await getServerConfig(pool);

    const clampBias = (v) => Math.max(-80, Math.min(80, Math.round(Number(v) || 0)));
    const nextRng = rngSettings ? {
      rouletteBias: clampBias(rngSettings.rouletteBias),
      slotsBias: clampBias(rngSettings.slotsBias),
      diceBias: clampBias(rngSettings.diceBias),
      cardsBias: clampBias(rngSettings.cardsBias),
      specialBias: clampBias(rngSettings.specialBias)
    } : current.rngSettings;

    let nextEvent = current.event;
    if (event) {
      if (event.clear) {
        nextEvent = { title: '', description: '', winMultiplier: 1.0, dailyBonus: 1000, expiresAt: 0, posterBase64: '' };
      } else {
        const durationHours = Math.max(1, Math.min(720, Number(event.durationHours) || 24));
        const expiresAt = event.expiresAt ? Number(event.expiresAt) : (Date.now() + durationHours * 3600 * 1000);
        const poster = typeof event.posterBase64 === 'string' && event.posterBase64.length < 1_500_000
          ? event.posterBase64
          : (current.event.posterBase64 || '');
        nextEvent = {
          title: String(event.title || 'EWENT SPECJALNY').slice(0, 40),
          description: String(event.description || 'Bonusowe mnożniki w grach!').slice(0, 140),
          winMultiplier: Math.max(1.0, Math.min(5.0, Number(event.winMultiplier) || 1.25)),
          dailyBonus: Math.max(500, Math.min(50000, Math.round(Number(event.dailyBonus) || 2000))),
          expiresAt,
          posterBase64: poster
        };
      }
    }

    await pool.query(
      'UPDATE casino_config SET rng_settings=$1, event_data=$2, updated_at=NOW() WHERE id=1',
      [nextRng, nextEvent]
    );
    res.json({ ok: true, message: 'Zapisano ustawienia losowości i ewentu!', ...(await getServerConfig(pool)) });
  });

  app.post('/api/device/start', authLimit, async (_, res) => {
    const deviceSecret = randomBytes(32).toString('hex');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += alphabet[randomInt(alphabet.length)];
    const expiresAt = new Date(Date.now() + 10 * 60000);
    await pool.query(
      'INSERT INTO casino_devices(secret_hash,user_code,expires_at) VALUES($1,$2,$3)',
      [passwords.sha(deviceSecret), code, expiresAt]
    );
    res.json({
      deviceSecret,
      userCode: code.slice(0, 4) + '-' + code.slice(4),
      verificationUrl: publicUrl + '/activate/',
      expiresAt: expiresAt.getTime(),
      interval: 5
    });
  });

  app.post('/api/device/approve', authLimit, async (req, res) => {
    const { code, nick, password, mode, newPassword } = req.body || {};
    if (typeof code !== 'string' || typeof nick !== 'string' || typeof password !== 'string' || password.length > 128 || password.length < 1) {
      fail('Uzupełnij kod, nick i hasło.');
    }
    if (!['login', 'register'].includes(mode)) fail('Wybierz logowanie albo rejestrację.');
    const cleanNick = nick.trim().toUpperCase();
    if (!cleanNick || cleanNick.length > 12 || /[\x00-\x1f]/.test(cleanNick)) fail('Nick: maksymalnie 12 znaków.');
    const userCode = code.replace(/[-\s]/g, '').toUpperCase();
    const d = await pool.query('SELECT * FROM casino_devices WHERE user_code=$1 AND expires_at>NOW() AND nick IS NULL', [userCode]);
    if (!d.rows[0]) fail('Kod jest nieprawidłowy, wykorzystany albo wygasł.', 400);
    const found = (await pool.query('SELECT * FROM players WHERE nick=$1', [cleanNick])).rows[0];
    let newHash;
    if (mode === 'register') {
      if (!/^[A-Z0-9_]{3,12}$/.test(cleanNick) || password.length < 10) {
        fail('Nowe konto: nick 3–12 znaków A–Z/0–9/_, hasło 10–128 znaków.');
      }
      if (found) fail('Nick jest zajęty.', 409);
      newHash = await passwords.hash(password);
    } else {
      if (!found || !(await passwords.verify(password, found.password_hash))) fail('Nieprawidłowy nick lub hasło.', 401);
      if (newPassword) {
        if (typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128) {
          fail('Nowe hasło: 10–128 znaków.');
        }
        newHash = await passwords.hash(newPassword);
      } else if (!found.password_hash.startsWith('scrypt$')) {
        newHash = await passwords.hash(password.trim());
      }
    }
    await transaction(pool, async (c) => {
      const cfg = await getServerConfig(c);
      const startCredits = cfg.event.active ? cfg.event.dailyBonus : 1000;
      const row = (await c.query('SELECT * FROM casino_devices WHERE user_code=$1 FOR UPDATE', [userCode])).rows[0];
      if (!row || row.nick || new Date(row.expires_at).getTime() <= Date.now()) {
        fail('Kod wygasł lub został wykorzystany.', 409);
      }
      if (mode === 'register') {
        await c.query(
          'INSERT INTO players(nick,password_hash,credits,last_bonus_date) VALUES($1,$2,$3,$4)',
          [cleanNick, newHash, startCredits, today()]
        );
      } else {
        const p = await playerLock(c, cleanNick);
        if (p.password_hash !== found.password_hash) fail('Dane konta zostały zmienione. Zaloguj się ponownie.', 409);
        if (newHash) await c.query('UPDATE players SET password_hash=$2 WHERE nick=$1', [cleanNick, newHash]);
        if (newPassword) await c.query('DELETE FROM casino_sessions WHERE nick=$1', [cleanNick]);
      }
      await c.query('UPDATE casino_devices SET nick=$2 WHERE user_code=$1', [userCode, cleanNick]);
    });
    res.json({ ok: true, message: 'Zatwierdzono! Zegarek za chwilę się zaloguje.' });
  });

  app.post('/api/device/poll', async (req, res) => {
    const secret = req.body?.deviceSecret;
    if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) fail('Nieprawidłowa sesja parowania.');
    const result = await transaction(pool, async (c) => {
      const d = (await c.query('SELECT * FROM casino_devices WHERE secret_hash=$1 FOR UPDATE', [passwords.sha(secret)])).rows[0];
      if (!d || new Date(d.expires_at).getTime() <= Date.now()) fail('Kod wygasł. Wygeneruj nowy.', 410);
      if (!d.nick) return { pending: true };
      const token = passwords.sha('casino-session-v2:' + secret);
      const tokenHash = passwords.sha(token);
      if (!d.claimed) {
        await c.query("INSERT INTO casino_sessions(token_hash,nick,expires_at) VALUES($1,$2,NOW()+INTERVAL '14 days')", [tokenHash, d.nick]);
        await c.query('UPDATE casino_devices SET claimed=TRUE WHERE secret_hash=$1', [passwords.sha(secret)]);
      } else if (!(await c.query('SELECT 1 FROM casino_sessions WHERE token_hash=$1 AND expires_at>NOW()', [tokenHash])).rows.length) {
        fail('Sesja unieważniona. Wygeneruj nowy kod.', 401);
      }
      return { pending: false, token, nick: d.nick };
    });
    res.json(result);
  });

  app.use('/api', async (req, res, next) => {
    const header = req.get('authorization') || '';
    if (!/^Bearer [a-f0-9]{64}$/.test(header)) fail('Zaloguj zegarek.', 401);
    req.tokenHash = passwords.sha(header.slice(7));
    const s = (await pool.query('SELECT nick FROM casino_sessions WHERE token_hash=$1 AND expires_at>NOW()', [req.tokenHash])).rows[0];
    if (!s) fail('Sesja wygasła. Zaloguj zegarek ponownie.', 401);
    req.nick = s.nick;
    next();
  });

  app.post('/api/logout', async (req, res) => {
    await pool.query('DELETE FROM casino_sessions WHERE token_hash=$1', [req.tokenHash]);
    res.json({ ok: true });
  });

  app.get('/api/me', async (req, res) =>
    res.json(
      await transaction(pool, async (c) => {
        const cfg = await getServerConfig(c);
        const p = await playerLock(c, req.nick);
        const bonusGranted = await bonus(c, p, cfg.event.dailyBonus);
        const a = await active(c, p);
        const last = a || (await c.query('SELECT * FROM casino_rounds WHERE nick=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [p.nick])).rows[0];
        const stats = (
          await c.query(
            `SELECT COUNT(*)::integer AS rounds,COALESCE(SUM(bet),0)::text AS wagered,
             COALESCE(SUM(payout),0)::text AS returned,COALESCE(MAX(payout),0)::text AS biggest,
             COUNT(*) FILTER(WHERE payout>bet)::integer AS wins FROM casino_rounds WHERE nick=$1 AND status='settled'`,
            [p.nick]
          )
        ).rows[0];
        return {
          nick: p.nick,
          credits: Number(p.credits),
          bonusGranted,
          bonusAmount: cfg.event.dailyBonus,
          stats,
          event: cfg.event,
          rngSettings: cfg.rngSettings,
          round: last ? games.publicRound(last.id, last.state) : null
        };
      })
    )
  );

  app.get('/api/history', async (req, res) => {
    const rows = (await pool.query('SELECT * FROM casino_rounds WHERE nick=$1 ORDER BY created_at DESC,id DESC LIMIT 20', [req.nick])).rows;
    res.json({ rounds: rows.map((r) => games.publicRound(r.id, r.state)) });
  });

  app.get('/api/leaderboard', async (_, res) => {
    const rows = (await pool.query('SELECT nick,credits FROM players ORDER BY credits DESC,nick LIMIT 50')).rows;
    res.json({ leaderboard: rows.map((r) => ({ ...r, credits: Number(r.credits) })) });
  });

  async function mutation(req, startRound) {
    const { requestId } = req.body || {};
    if (typeof requestId !== 'string' || !UUID.test(requestId)) fail('Wymagany requestId UUID.');
    const operation = startRound
      ? { kind: 'start', game: req.body.game, bet: req.body.bet, choice: req.body.choice || '' }
      : { kind: 'action', roundId: req.params.id, action: req.body.action };
    if (startRound) {
      games.validate(operation.game, operation.bet, operation.choice);
    } else if (
      !UUID.test(operation.roundId) ||
      !(['hit', 'stand', 'cashout', 'higher', 'lower'].includes(operation.action) || /^pick_\d+$/.test(operation.action))
    ) {
      fail('Nieprawidłowa akcja.');
    }
    const fingerprint = passwords.sha(JSON.stringify(operation));
    return transaction(pool, async (c) => {
      const cfg = await getServerConfig(c);
      const p = await playerLock(c, req.nick);
      const bonusGranted = await bonus(c, p, cfg.event.dailyBonus);
      const previous = (await c.query('SELECT * FROM casino_requests WHERE nick=$1 AND request_id=$2', [p.nick, requestId])).rows[0];
      let row;
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('Ten requestId ma już inne dane.', 409);
        row = (await c.query('SELECT * FROM casino_rounds WHERE id=$1 AND nick=$2 FOR UPDATE', [previous.response.roundId, p.nick])).rows[0];
        games.advance(row.state);
        await persist(c, p, row);
      } else if (startRound) {
        if (await active(c, p)) fail('Dokończ aktywną rundę.', 409);
        if (Number(p.credits) < operation.bet) fail('Za mało żetonów.', 409);
        const state = games.start(operation.game, operation.bet, operation.choice, Date.now(), randomInt, {
          rngSettings: cfg.rngSettings,
          eventMultiplier: cfg.event.winMultiplier
        });
        await balance(c, p, -operation.bet + (state.status === 'settled' ? state.payout : 0));
        row = { id: randomUUID(), state, status: state.status };
        await c.query(
          `INSERT INTO casino_rounds(id,nick,game,bet,payout,state,status,settled_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7='settled' THEN NOW() ELSE NULL END)`,
          [row.id, p.nick, state.game, state.bet, state.payout, state, state.status]
        );
      } else {
        row = (await c.query('SELECT * FROM casino_rounds WHERE id=$1 AND nick=$2 FOR UPDATE', [operation.roundId, p.nick])).rows[0];
        if (!row) fail('Nie znaleziono rundy.', 404);
        games.action(row.state, operation.action);
        await persist(c, p, row);
      }
      if (!previous) {
        await c.query(
          'INSERT INTO casino_requests(nick,request_id,fingerprint,response) VALUES($1,$2,$3,$4)',
          [p.nick, requestId, fingerprint, { roundId: row.id }]
        );
      }
      return {
        credits: Number(p.credits),
        bonusGranted,
        event: cfg.event,
        round: games.publicRound(row.id, row.state),
        replayed: !!previous
      };
    });
  }

  app.post('/api/rounds', async (req, res) => res.json(await mutation(req, true)));
  app.post('/api/rounds/:id/actions', async (req, res) => res.json(await mutation(req, false)));
  app.get('/api/rounds/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) fail('Nieprawidłowe ID rundy.');
    res.json(
      await transaction(pool, async (c) => {
        const p = await playerLock(c, req.nick);
        const row = (await c.query('SELECT * FROM casino_rounds WHERE id=$1 AND nick=$2 FOR UPDATE', [req.params.id, p.nick])).rows[0];
        if (!row) fail('Nie znaleziono rundy.', 404);
        games.advance(row.state);
        await persist(c, p, row);
        return { credits: Number(p.credits), round: games.publicRound(row.id, row.state) };
      })
    );
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.code === '23505' ? 409 : err.status || 500;
    if (status >= 500) console.error('Request failed:', err.code || err.name);
    res.status(status).json({
      ok: false,
      error: status === 500 ? 'Błąd serwera. Ponów żądanie.' : err.code === '23505' ? 'Wpis już istnieje. Spróbuj ponownie.' : err.message
    });
  });
  return app;
}

module.exports = { createApp, transaction, today };