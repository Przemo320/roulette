const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const MOJ_LINK_DO_BAZY = "postgresql://roulette_server_users_2vk2_user:0ksN5VhQEVLIoXrZfJAnf4QsHgWcFQHS@dpg-dbjt22k9v7es73b2n5r0-a.oregon-postgres.render.com/roulette_server_users_2vk2";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || MOJ_LINK_DO_BAZY,
  ssl: { rejectUnauthorized: false }
});

// Automatyczne tworzenie tabeli graczy przy starcie serwera
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        nick VARCHAR(16) PRIMARY KEY,
        password_hash TEXT NOT NULL,
        credits INTEGER NOT NULL DEFAULT 1000,
        last_bonus_date VARCHAR(16) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Baza danych PostgreSQL gotowa!');
  } catch (err) {
    console.error('Błąd inicjalizacji bazy danych (sprawdź zmienną DATABASE_URL):', err);
  }
}
initDatabase();

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password).trim()).digest('hex');
}

function getTodayDateString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

async function getSortedLeaderboard() {
  const result = await pool.query(
    'SELECT nick, credits FROM players ORDER BY credits DESC LIMIT 50'
  );
  return result.rows;
}

// Lekki endpoint dla cron-job.org (tylko 2 bajty - eliminuje błąd rozmiaru danych!)
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.status(200).send('OK');
});

// Logowanie lub rejestracja nowego konta w bazie danych
app.post('/login', async (req, res) => {
  try {
    const { nick, password } = req.body;

    if (!nick || typeof nick !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ ok: false, error: 'WPISZ NICK I HASŁO' });
    }

    const cleanNick = nick.trim().toUpperCase().slice(0, 12);
    const cleanPass = password.trim();

    if (!cleanNick || cleanPass.length < 2) {
      return res.status(400).json({ ok: false, error: 'ZA KRÓTKIE DANE' });
    }

    const passHash = hashPassword(cleanPass);
    const today = getTodayDateString();

    const userRes = await pool.query('SELECT * FROM players WHERE nick = $1', [cleanNick]);

    // Jeśli gracz nie istnieje -> tworzymy nowe konto w bazie z 1000$
    if (userRes.rows.length === 0) {
      await pool.query(
        'INSERT INTO players (nick, password_hash, credits, last_bonus_date, updated_at) VALUES ($1, $2, 1000, $3, NOW())',
        [cleanNick, passHash, today]
      );

      const leaderboard = await getSortedLeaderboard();
      return res.json({
        ok: true,
        isNew: true,
        nick: cleanNick,
        credits: 1000,
        bonusGranted: false,
        leaderboard
      });
    }

    const player = userRes.rows[0];

    // Sprawdzenie hasła
    if (player.password_hash !== passHash) {
      return res.status(401).json({
        ok: false,
        error: 'ZŁE HASŁO / NICK ZAJĘTY!'
      });
    }

    // Sprawdzenie dziennego bonusu (+1000$)
    let newCredits = player.credits;
    let bonusGranted = false;
    if (player.last_bonus_date !== today) {
      newCredits += 1000;
      bonusGranted = true;
      await pool.query(
        'UPDATE players SET credits = $1, last_bonus_date = $2, updated_at = NOW() WHERE nick = $3',
        [newCredits, today, cleanNick]
      );
    }

    const leaderboard = await getSortedLeaderboard();
    res.json({
      ok: true,
      isNew: false,
      nick: player.nick,
      credits: newCredits,
      bonusGranted,
      leaderboard
    });
  } catch (err) {
    console.error('Błąd /login:', err);
    res.status(500).json({ ok: false, error: 'BŁĄD BAZY DANYCH' });
  }
});

// Synchronizacja hajsu w trakcie gry
app.post('/sync', async (req, res) => {
  try {
    const { nick, password, credits } = req.body;

    if (!nick || !password || typeof credits !== 'number') {
      return res.status(400).json({ ok: false, error: 'BŁĘDNE DANE SYNC' });
    }

    const cleanNick = String(nick).trim().toUpperCase().slice(0, 12);
    const passHash = hashPassword(password);
    const today = getTodayDateString();

    const userRes = await pool.query('SELECT * FROM players WHERE nick = $1', [cleanNick]);
    if (userRes.rows.length === 0 || userRes.rows[0].password_hash !== passHash) {
      return res.status(401).json({ ok: false, error: 'BŁĄD AUTORYZACJI' });
    }

    const player = userRes.rows[0];
    let updatedCredits = Math.max(0, Math.floor(credits));
    let bonusGranted = false;

    if (player.last_bonus_date !== today) {
      updatedCredits += 1000;
      bonusGranted = true;
    }

    await pool.query(
      'UPDATE players SET credits = $1, last_bonus_date = $2, updated_at = NOW() WHERE nick = $3',
      [updatedCredits, today, cleanNick]
    );

    const leaderboard = await getSortedLeaderboard();
    res.json({
      ok: true,
      credits: updatedCredits,
      bonusGranted,
      leaderboard
    });
  } catch (err) {
    console.error('Błąd /sync:', err);
    res.status(500).json({ ok: false, error: 'BŁĄD BAZY DANYCH' });
  }
});

app.get('/leaderboard', async (req, res) => {
  try {
    const leaderboard = await getSortedLeaderboard();
    res.json({ ok: true, leaderboard });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'BŁĄD BAZY DANYCH' });
  }
});

app.listen(PORT, () => {
  console.log(`Serwer kasyna działa na porcie ${PORT}`);
});