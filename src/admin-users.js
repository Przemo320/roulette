'use strict';
const express = require('express');
const passwords = require('./passwords');
const { fail, publicRound } = require('./games');

function pageOptions(query) {
  const integer = (value, fallback, max) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || Number(value) > max) fail('Nieprawidłowa strona lub limit.');
    return Number(value);
  };
  return { page: integer(query.page, 1, 1000000), limit: integer(query.limit, 20, 50) };
}

function accountNick(value) {
  if (typeof value !== 'string' || !value || value.length > 16 || /[\x00-\x1f\x7f]/.test(value)) fail('Nieprawidłowy login gracza.');
  return value.toUpperCase();
}

async function findPlayer(c, nick, lock = false) {
  const result = await c.query(
    `SELECT nick,credits,last_bonus_date,updated_at FROM players WHERE nick=$1${lock ? ' FOR UPDATE' : ''}`, [nick]
  );
  if (!result.rows[0]) fail('Nie znaleziono użytkownika.', 404);
  const player = result.rows[0];
  return { nick: player.nick, credits: Number(player.credits), lastBonusDate: player.last_bonus_date, updatedAt: player.updated_at };
}

function createAdminUsers({ pool, transaction, requireAdmin, requireCsrf }) {
  const router = express.Router();
  router.use(requireAdmin);

  router.get('/', async (req, res) => {
    const { page, limit } = pageOptions(req.query);
    const search = req.query.search === undefined ? '' : req.query.search;
    if (typeof search !== 'string' || search.length > 32) fail('Wyszukiwanie: maksymalnie 32 znaki.');
    const result = await transaction(pool, async c => {
      const filter = search.trim().toUpperCase();
      const total = Number((await c.query('SELECT COUNT(*) AS n FROM players WHERE strpos(nick,$1)>0', [filter])).rows[0].n);
      const { rows } = await c.query(
        `SELECT p.nick,p.credits,p.updated_at,
          (SELECT COUNT(*) FROM casino_rounds r WHERE r.nick=p.nick) AS rounds,
          (SELECT MAX(created_at) FROM casino_rounds r WHERE r.nick=p.nick) AS last_played_at
         FROM players p WHERE strpos(p.nick,$1)>0 ORDER BY p.nick LIMIT $2 OFFSET $3`,
        [filter, limit, (page - 1) * limit]
      );
      return { total, users: rows.map(p => ({ nick: p.nick, credits: Number(p.credits), updatedAt: p.updated_at, rounds: Number(p.rounds), lastPlayedAt: p.last_played_at })) };
    });
    res.json({ ok: true, page, limit, ...result });
  });

  router.get('/:nick', async (req, res) => {
    const nick = accountNick(req.params.nick);
    const data = await transaction(pool, async c => {
      const user = await findPlayer(c, nick);
      const stats = (await c.query(
        `SELECT COUNT(*)::integer AS rounds,
          COUNT(*) FILTER(WHERE status='active')::integer AS active,
          COUNT(*) FILTER(WHERE status='settled' AND payout>bet)::integer AS wins,
          COALESCE(SUM(bet) FILTER(WHERE status='settled'),0)::text AS wagered,
          COALESCE(SUM(payout) FILTER(WHERE status='settled'),0)::text AS returned,
          COALESCE(SUM(payout-bet) FILTER(WHERE status='settled'),0)::text AS profit,
          COALESCE(MAX(payout) FILTER(WHERE status='settled'),0)::text AS biggest
         FROM casino_rounds WHERE nick=$1`, [nick]
      )).rows[0];
      const sessions = Number((await c.query('SELECT COUNT(*) AS n FROM casino_sessions WHERE nick=$1 AND expires_at>NOW()', [nick])).rows[0].n);
      return { user, stats, activeSessions: sessions };
    });
    res.json({ ok: true, ...data });
  });

  router.get('/:nick/history', async (req, res) => {
    const nick = accountNick(req.params.nick);
    const { page, limit } = pageOptions(req.query);
    const data = await transaction(pool, async c => {
      await findPlayer(c, nick);
      const total = Number((await c.query('SELECT COUNT(*) AS n FROM casino_rounds WHERE nick=$1', [nick])).rows[0].n);
      const { rows } = await c.query(
        'SELECT id,game,bet,payout,status,state,created_at,settled_at FROM casino_rounds WHERE nick=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',
        [nick, limit, (page - 1) * limit]
      );
      return { total, rounds: rows.map(r => ({ ...publicRound(r.id, r.state), id: r.id, game: r.game, bet: Number(r.bet), payout: Number(r.payout), status: r.status, createdAt: r.created_at, settledAt: r.settled_at })) };
    });
    res.json({ ok: true, page, limit, ...data });
  });

  router.patch('/:nick', requireCsrf, async (req, res) => {
    const nick = accountNick(req.params.nick);
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length ||
        Object.keys(body).some(key => !['nick', 'password'].includes(key))) fail('Możesz zmienić login lub hasło gracza.');
    let newNick = nick;
    if (Object.hasOwn(body, 'nick')) {
      if (typeof body.nick !== 'string') fail('Nieprawidłowy nowy login.');
      newNick = body.nick.trim().toUpperCase();
      // An unchanged legacy login does not prevent a password reset.
      if (newNick !== nick && !/^[A-Z0-9_]{3,12}$/.test(newNick)) fail('Nowy login: 3–12 znaków A–Z, 0–9 lub _.');
    }
    let passwordHash;
    if (Object.hasOwn(body, 'password')) {
      if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) fail('Nowe hasło: od 10 do 128 znaków.');
      passwordHash = await passwords.hash(body.password);
    }
    const changedNick = newNick !== nick;
    const user = await transaction(pool, async c => {
      await findPlayer(c, nick, true);
      if (changedNick) {
        if ((await c.query('SELECT nick FROM players WHERE nick=$1', [newNick])).rows.length) fail('Ten login jest już zajęty.', 409);
        await c.query('UPDATE players SET nick=$2,updated_at=NOW() WHERE nick=$1', [nick, newNick]);
      }
      if (passwordHash) await c.query('UPDATE players SET password_hash=$2,updated_at=NOW() WHERE nick=$1', [newNick, passwordHash]);
      if (changedNick || passwordHash) {
        // Approved pairing secrets must be revoked as well as watch bearer sessions.
        await c.query('DELETE FROM casino_sessions WHERE nick=$1', [newNick]);
        await c.query('DELETE FROM casino_devices WHERE nick=$1', [newNick]);
      }
      return findPlayer(c, newNick);
    });
    res.json({ ok: true, user, sessionsRevoked: Boolean(changedNick || passwordHash), message: changedNick || passwordHash ? 'Zapisano konto. Zegarki gracza zostały wylogowane; połącz je ponownie.' : 'Dane konta nie zmieniły się.' });
  });

  router.delete('/:nick', requireCsrf, async (req, res) => {
    const nick = accountNick(req.params.nick);
    if (req.body?.confirmNick !== nick) fail('Wpisz dokładny login usuwanego konta, aby potwierdzić.');
    await transaction(pool, async c => {
      await findPlayer(c, nick, true);
      // Foreign keys remove the account's sessions, devices, rounds and request ledger.
      await c.query('DELETE FROM players WHERE nick=$1', [nick]);
    });
    res.json({ ok: true, message: 'Usunięto konto, jego historię i połączenia z zegarkami.' });
  });
  return router;
}

module.exports = { createAdminUsers };
