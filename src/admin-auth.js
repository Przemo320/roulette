'use strict';
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const passwords = require('./passwords');
const { fail } = require('./games');

const SESSION_MS = 8 * 60 * 60 * 1000;

function constantEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(at + 1).trim()); } catch (_) { return ''; }
  }
  return '';
}

function createAdminAuth(pool, options = {}) {
  const username = String(options.adminUsername ?? process.env.ADMIN_USERNAME ?? 'admin').trim();
  const password = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? '';
  const configured = username.length > 0 && username.length <= 64 &&
    typeof password === 'string' && password.length >= 12 && password.length <= 128;
  const secure = new URL(options.publicUrl).protocol === 'https:';
  const cookieName = secure ? '__Host-casino_admin' : 'casino_admin';
  const cookieOptions = { httpOnly: true, secure, sameSite: 'strict', path: '/' };
  const router = express.Router();
  const hashPromise = configured ? passwords.hash(password).catch(() => null) : Promise.resolve(null);
  const credentialChecks = new Map();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  async function sameCredentials(storedHash) {
    if (storedHash === await hashPromise) return true;
    // Existing sessions survive a restart, but changing the administrator password revokes them.
    if (!credentialChecks.has(storedHash)) {
      if (credentialChecks.size >= 16) credentialChecks.delete(credentialChecks.keys().next().value);
      const check = passwords.verify(password, storedHash).catch(error => {
        credentialChecks.delete(storedHash);
        throw error;
      });
      credentialChecks.set(storedHash, check);
    }
    return credentialChecks.get(storedHash);
  }

  async function requireAdmin(req, res, next) {
    const token = readCookie(req, cookieName);
    if (!configured || !/^[a-f0-9]{64}$/.test(token)) fail('Zaloguj się jako administrator.', 401);
    const tokenHash = passwords.sha(token);
    const session = (await pool.query(
      'SELECT username,credential_hash,expires_at FROM casino_admin_sessions WHERE token_hash=$1 AND expires_at>NOW()',
      [tokenHash]
    )).rows[0];
    if (!session || session.username !== username || !(await sameCredentials(session.credential_hash))) {
      if (session) await pool.query('DELETE FROM casino_admin_sessions WHERE token_hash=$1', [tokenHash]);
      res.clearCookie(cookieName, cookieOptions);
      fail('Sesja administratora wygasła. Zaloguj się ponownie.', 401);
    }
    req.adminSession = {
      username, tokenHash, expiresAt: new Date(session.expires_at).getTime(),
      csrfToken: passwords.sha('casino-admin-csrf:' + token)
    };
    next();
  }

  function requireCsrf(req, res, next) {
    const supplied = req.get('x-csrf-token') || '';
    if (!req.adminSession || !constantEqual(supplied, req.adminSession.csrfToken)) {
      fail('Odśwież panel administratora i spróbuj ponownie.', 403);
    }
    next();
  }

  const loginLimit = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 15,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { ok: false, error: 'Za dużo prób logowania. Spróbuj później.' }
  });

  router.post('/login', loginLimit, async (req, res) => {
    const login = req.body?.username;
    const supplied = req.body?.password;
    if (!configured || !(await hashPromise)) fail('Panel administratora nie został skonfigurowany.', 503);
    if (typeof login !== 'string' || login.length > 64 ||
        typeof supplied !== 'string' || supplied.length < 1 || supplied.length > 128) {
      fail('Nieprawidłowy login lub hasło.', 401);
    }
    const passwordMatches = await passwords.verify(supplied, await hashPromise);
    if (!constantEqual(login.trim(), username) || !passwordMatches) fail('Nieprawidłowy login lub hasło.', 401);
    const previous = readCookie(req, cookieName);
    if (/^[a-f0-9]{64}$/.test(previous)) {
      await pool.query('DELETE FROM casino_admin_sessions WHERE token_hash=$1', [passwords.sha(previous)]);
    }
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_MS);
    await pool.query(
      'INSERT INTO casino_admin_sessions(token_hash,username,credential_hash,expires_at) VALUES($1,$2,$3,$4)',
      [passwords.sha(token), username, await hashPromise, expiresAt]
    );
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: SESSION_MS });
    res.json({ ok: true, username, expiresAt: expiresAt.getTime(), csrfToken: passwords.sha('casino-admin-csrf:' + token) });
  });

  router.get('/session', requireAdmin, (req, res) => {
    res.json({ ok: true, username: req.adminSession.username,
      expiresAt: req.adminSession.expiresAt, csrfToken: req.adminSession.csrfToken });
  });

  router.post('/logout', requireAdmin, requireCsrf, async (req, res) => {
    await pool.query('DELETE FROM casino_admin_sessions WHERE token_hash=$1', [req.adminSession.tokenHash]);
    res.clearCookie(cookieName, cookieOptions);
    res.json({ ok: true });
  });

  return { router, requireAdmin, requireCsrf };
}

module.exports = { createAdminAuth };
