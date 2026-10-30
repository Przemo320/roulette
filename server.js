const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'players.json');

app.use(cors());
app.use(express.json());

let players = {};
if (fs.existsSync(DB_FILE)) {
  try {
    players = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (err) {
    console.error('Błąd odczytu players.json, tworzę nową bazę:', err);
    players = {};
  }
}

function saveDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(players, null, 2), 'utf-8');
  } catch (err) {
    console.error('Błąd zapisu players.json:', err);
  }
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password).trim()).digest('hex');
}

// Bieżąca data w polskiej strefie czasowej (YYYY-MM-DD)
function getTodayDateString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

// Sprawdza czy graczowi należy się dzisiejsze +1000$
function checkAndApplyDailyBonus(player) {
  const today = getTodayDateString();
  if (player.lastBonusDate !== today) {
    player.credits = (player.credits || 0) + 1000;
    player.lastBonusDate = today;
    return true;
  }
  return false;
}

function getSortedLeaderboard() {
  return Object.values(players)
    .map(p => ({ nick: p.nick, credits: p.credits }))
    .sort((a, b) => b.credits - a.credits)
    .slice(0, 50);
}

// Logowanie lub rejestracja nowego konta
app.post('/login', (req, res) => {
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
  const existing = players[cleanNick];

  // Nowe konto
  if (!existing) {
    players[cleanNick] = {
      nick: cleanNick,
      passwordHash: passHash,
      credits: 1000,
      lastBonusDate: today,
      updatedAt: new Date().toISOString()
    };
    saveDatabase();

    return res.json({
      ok: true,
      isNew: true,
      nick: cleanNick,
      credits: 1000,
      bonusGranted: false,
      leaderboard: getSortedLeaderboard()
    });
  }

  // Konto istnieje, ale wcześniej nie miało hasła (migracja ze starej wersji)
  if (!existing.passwordHash) {
    existing.passwordHash = passHash;
  } else if (existing.passwordHash !== passHash) {
    return res.status(401).json({
      ok: false,
      error: 'ZŁE HASŁO / NICK ZAJĘTY!'
    });
  }

  const bonusGranted = checkAndApplyDailyBonus(existing);
  existing.updatedAt = new Date().toISOString();
  saveDatabase();

  res.json({
    ok: true,
    isNew: false,
    nick: existing.nick,
    credits: existing.credits,
    bonusGranted,
    leaderboard: getSortedLeaderboard()
  });
});

// Synchronizacja hajsu w trakcie gry (wymaga poprawnego hasła)
app.post('/sync', (req, res) => {
  const { nick, password, credits } = req.body;

  if (!nick || !password || typeof credits !== 'number') {
    return res.status(400).json({ ok: false, error: 'BŁĘDNE DANE SYNC' });
  }

  const cleanNick = String(nick).trim().toUpperCase().slice(0, 12);
  const passHash = hashPassword(password);
  const player = players[cleanNick];

  if (!player || player.passwordHash !== passHash) {
    return res.status(401).json({ ok: false, error: 'BŁĄD AUTORYZACJI' });
  }

  // Aktualizacja salda z zegarka + sprawdzenie czy wybiła północ (nowy dzień)
  player.credits = Math.max(0, Math.floor(credits));
  const bonusGranted = checkAndApplyDailyBonus(player);
  player.updatedAt = new Date().toISOString();

  saveDatabase();

  res.json({
    ok: true,
    credits: player.credits,
    bonusGranted,
    leaderboard: getSortedLeaderboard()
  });
});

app.get('/leaderboard', (req, res) => {
  res.json({
    ok: true,
    leaderboard: getSortedLeaderboard()
  });
});

app.get('/', (req, res) => {
  res.send('Watch Casino Server działa! Graczy w bazie: ' + Object.keys(players).length);
});

app.listen(PORT, () => {
  console.log(`Serwer kasyna nasłuchuje na porcie ${PORT}`);
});