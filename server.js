const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'players.json');

app.use(cors());
app.use(express.json());

// Wczytanie bazy z pliku JSON przy starcie serwera
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

function getSortedLeaderboard() {
  return Object.values(players)
    .sort((a, b) => b.credits - a.credits)
    .slice(0, 50);
}

// Endpoint aktualizujący stan konta gracza i zwracający aktualny ranking
app.post('/sync', (req, res) => {
  const { nick, credits } = req.body;

  if (!nick || typeof nick !== 'string' || typeof credits !== 'number') {
    return res.status(400).json({ error: 'Wymagany poprawny nick oraz credits' });
  }

  const cleanNick = nick.trim().toUpperCase().slice(0, 12);
  if (!cleanNick) {
    return res.status(400).json({ error: 'Pusty nick' });
  }

  players[cleanNick] = {
    nick: cleanNick,
    credits: Math.max(0, Math.floor(credits)),
    updatedAt: new Date().toISOString()
  };

  saveDatabase();

  res.json({
    ok: true,
    leaderboard: getSortedLeaderboard()
  });
});

// Endpoint do samego pobrania statystyk
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