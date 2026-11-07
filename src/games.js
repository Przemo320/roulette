'use strict';
const { randomInt } = require('node:crypto');

const GAMES = [
  'roulette', 'slots', 'dice', 'blackjack', 'crash', 'plinko',
  'mines', 'wheel', 'hilo', 'baccarat'
];
const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const SLOT_MULTIPLIERS = [25,12,8,5,3];
const PLINKO_MULTIPLIERS = [8,2,0,2,8];
const WHEEL_SEGMENTS = [0, 1.5, 2, 0, 3, 1.5, 5, 0, 2, 1.5, 10, 0];
const GROWTH = 0.26;

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

function score(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    total += c.rank === 1 ? 11 : Math.min(c.rank, 10);
    if (c.rank === 1) aces++;
  }
  while (total > 21 && aces-- > 0) total -= 10;
  return total;
}

function baccaratScore(cards) {
  let sum = 0;
  for (const c of cards) sum += c.rank >= 10 ? 0 : c.rank;
  return sum % 10;
}

function hiloMultipliers(rank) {
  const lowerCount = Math.max(1, rank - 1);
  const higherCount = Math.max(1, 13 - rank);
  const lowM = Math.min(6.5, Math.max(1.12, Math.round((11.5 / lowerCount) * 100) / 100));
  const highM = Math.min(6.5, Math.max(1.12, Math.round((11.5 / higherCount) * 100) / 100));
  return { lowM, highM };
}

function deck(rng = randomInt) {
  const cards = Array.from({ length: 52 }, (_, i) => ({ rank: (i % 13) + 1, suit: Math.floor(i / 13) }));
  for (let i = 51; i > 0; i--) {
    const j = rng(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function validate(game, bet, choice) {
  if (!GAMES.includes(game)) fail('Nieznana gra.');
  if (!Number.isSafeInteger(bet) || bet < 1 || bet > 500) fail('Stawka musi być całkowita: 1–500.');
  if (typeof choice !== 'string' || choice.length > 16) fail('Nieprawidłowy wybór.');
  if (game === 'roulette' && !['RED', 'BLACK', 'ZERO'].includes(choice)) fail('Nieprawidłowy zakład ruletki.');
  if (game === 'dice' && !['UNDER_7', 'LUCKY_7', 'OVER_7'].includes(choice)) fail('Nieprawidłowy zakład kości.');
  if (game === 'mines' && !['2', '4', '6'].includes(choice)) fail('Wybierz 2, 4 lub 6 min.');
  if (game === 'baccarat' && !['PLAYER', 'TIE', 'BANKER'].includes(choice)) fail('Nieprawidłowy zakład Baccarat.');
  if (!['roulette', 'dice', 'mines', 'baccarat'].includes(game) && choice !== '') {
    fail('Ta gra nie przyjmuje wyboru zakładu.');
  }
}

// bias w zakresie -80 (przewaga kasyna) do +80 (szczęście gracza)
function shouldForceWin(bias, rng) {
  return bias > 0 && rng(100) < bias;
}
function shouldForceLoss(bias, rng) {
  return bias < 0 && rng(100) < Math.abs(bias);
}

function applyEventMultiplier(bet, rawPayout, eventMult = 1.0) {
  if (rawPayout <= bet || eventMult <= 1.0) return Math.floor(rawPayout);
  const profit = rawPayout - bet;
  return Math.floor(bet + profit * eventMult);
}

function settle(s, payout, message, eventMult = 1.0) {
  s.status = 'settled';
  s.payout = applyEventMultiplier(s.bet, payout, eventMult);
  s.message = s.payout > payout ? `${message} (Ewent ×${eventMult})` : message;
  return s;
}

function start(game, bet, choice, now = Date.now(), rng = randomInt, runtimeCfg = {}) {
  validate(game, bet, choice);
  const rngCfg = runtimeCfg.rngSettings || {};
  const eventMult = Number(runtimeCfg.eventMultiplier) || 1.0;

  const s = {
    game, bet, choice: choice || '', status: 'settled',
    payout: 0, startedAt: now, message: '', eventMult
  };

  if (game === 'roulette') {
    const bias = Number(rngCfg.rouletteBias) || 0;
    const isWin = (n) => choice === 'ZERO' ? n === 0 : n !== 0 && (choice === 'RED') === RED.has(n);
    let n = rng(37);
    if (shouldForceWin(bias, rng) && !isWin(n)) {
      const winners = Array.from({ length: 37 }, (_, i) => i).filter(isWin);
      n = winners[rng(winners.length)];
    } else if (shouldForceLoss(bias, rng) && isWin(n)) {
      const losers = Array.from({ length: 37 }, (_, i) => i).filter(x => !isWin(x));
      n = losers[rng(losers.length)];
    }
    s.number = n;
    const won = isWin(n);
    return settle(s, won ? bet * (choice === 'ZERO' ? 36 : 2) : 0, `Wypadło ${n}`, eventMult);
  }

  if (game === 'slots') {
    const bias = Number(rngCfg.slotsBias) || 0;
    let symbols = [rng(5), rng(5), rng(5)];
    if (shouldForceWin(bias, rng)) {
      const sym = rng(5);
      symbols = rng(100) < 40 ? [sym, sym, sym] : [sym, sym, (sym + 1) % 5];
    } else if (shouldForceLoss(bias, rng) && (symbols[0] === symbols[1] || symbols[1] === symbols[2] || symbols[0] === symbols[2])) {
      symbols = [0, 1, 2];
    }
    s.symbols = symbols;
    const [a, b, c] = symbols;
    const mult = a === b && b === c ? SLOT_MULTIPLIERS[a] : (a === b || b === c || a === c ? 2 : 0);
    return settle(s, bet * mult, `Automat ×${mult}`, eventMult);
  }

  if (game === 'dice') {
    const bias = Number(rngCfg.diceBias) || 0;
    const isWin = (sum) => choice === 'UNDER_7' ? sum < 7 : choice === 'OVER_7' ? sum > 7 : sum === 7;
    let d1 = rng(6) + 1, d2 = rng(6) + 1;
    if (shouldForceWin(bias, rng) && !isWin(d1 + d2)) {
      for (let t = 0; t < 25; t++) {
        d1 = rng(6) + 1; d2 = rng(6) + 1;
        if (isWin(d1 + d2)) break;
      }
    } else if (shouldForceLoss(bias, rng) && isWin(d1 + d2)) {
      for (let t = 0; t < 25; t++) {
        d1 = rng(6) + 1; d2 = rng(6) + 1;
        if (!isWin(d1 + d2)) break;
      }
    }
    s.dice = [d1, d2];
    const sum = d1 + d2;
    const won = isWin(sum);
    return settle(s, won ? bet * (choice === 'LUCKY_7' ? 4 : 2) : 0, `Suma ${sum}`, eventMult);
  }

  if (game === 'plinko') {
    const bias = Number(rngCfg.specialBias) || 0;
    let r = rng(100);
    let bucket = r < 2 ? 0 : r < 18 ? 1 : r < 82 ? 2 : r < 98 ? 3 : 4;
    if (shouldForceWin(bias, rng) && bucket === 2) {
      bucket = rng(100) < 35 ? (rng(2) === 0 ? 0 : 4) : (rng(2) === 0 ? 1 : 3);
    } else if (shouldForceLoss(bias, rng) && bucket !== 2) {
      bucket = 2;
    }
    s.bucket = bucket;
    return settle(s, bet * PLINKO_MULTIPLIERS[bucket], `Koszyk ×${PLINKO_MULTIPLIERS[bucket]}`, eventMult);
  }

  if (game === 'wheel') {
    const bias = Number(rngCfg.specialBias) || 0;
    let seg = rng(WHEEL_SEGMENTS.length);
    if (shouldForceWin(bias, rng) && WHEEL_SEGMENTS[seg] === 0) {
      const winSegs = WHEEL_SEGMENTS.map((m, i) => m > 0 ? i : -1).filter(i => i >= 0);
      seg = winSegs[rng(winSegs.length)];
    } else if (shouldForceLoss(bias, rng) && WHEEL_SEGMENTS[seg] > 0) {
      const loseSegs = WHEEL_SEGMENTS.map((m, i) => m === 0 ? i : -1).filter(i => i >= 0);
      seg = loseSegs[rng(loseSegs.length)];
    }
    s.segment = seg;
    const mult = WHEEL_SEGMENTS[seg];
    return settle(s, Math.floor(bet * mult), `Koło ×${mult}`, eventMult);
  }

  if (game === 'baccarat') {
    const bias = Number(rngCfg.cardsBias) || 0;
    let d = deck(rng);
    let pHand = [d.pop(), d.pop()];
    let bHand = [d.pop(), d.pop()];
    let pScore = baccaratScore(pHand), bScore = baccaratScore(bHand);
    if (pScore < 8 && bScore < 8) {
      if (pScore <= 5) pHand.push(d.pop());
      if (bScore <= 5) bHand.push(d.pop());
      pScore = baccaratScore(pHand);
      bScore = baccaratScore(bHand);
    }
    const winner = pScore > bScore ? 'PLAYER' : bScore > pScore ? 'BANKER' : 'TIE';
    if (shouldForceLoss(bias, rng) && winner === choice) {
      const tmp = pHand; pHand = bHand; bHand = tmp;
      pScore = baccaratScore(pHand); bScore = baccaratScore(bHand);
    }
    s.player = pHand;
    s.dealer = bHand;
    const finalWinner = pScore > bScore ? 'PLAYER' : bScore > pScore ? 'BANKER' : 'TIE';
    const mult = choice === 'TIE' ? 9 : 2;
    const rawPayout = finalWinner === choice ? bet * mult : (finalWinner === 'TIE' ? bet : 0);
    return settle(s, rawPayout, `Gracz ${pScore} : ${bScore} Bankier`, eventMult);
  }

  if (game === 'blackjack') {
    s.deck = deck(rng);
    s.player = [s.deck.pop(), s.deck.pop()];
    s.dealer = [s.deck.pop(), s.deck.pop()];
    const p = score(s.player), d = score(s.dealer);
    if (p === 21 || d === 21) {
      return settle(
        s,
        p === d ? bet : p === 21 ? Math.floor(bet * 2.5) : 0,
        p === d ? 'Remis' : p === 21 ? 'Blackjack 3:2' : 'Blackjack krupiera',
        eventMult
      );
    }
    s.status = 'active';
    s.expiresAt = now + 15 * 60 * 1000;
    s.message = 'Dobierz albo pasuj';
    return s;
  }

  if (game === 'mines') {
    const bombsCount = Number(choice) || 4;
    const allIdx = Array.from({ length: 16 }, (_, i) => i);
    for (let i = 15; i > 0; i--) {
      const j = rng(i + 1);
      [allIdx[i], allIdx[j]] = [allIdx[j], allIdx[i]];
    }
    s.bombsCount = bombsCount;
    s.bombs = allIdx.slice(0, bombsCount);
    s.revealed = [];
    s.multiplier = 1.0;
    s.status = 'active';
    s.expiresAt = now + 15 * 60 * 1000;
    s.message = 'Odkryj pole lub wypłać';
    return s;
  }

  if (game === 'hilo') {
    s.deck = deck(rng);
    let first = s.deck.pop();
    while (first.rank === 1 || first.rank === 13) first = s.deck.pop();
    s.currentCard = first;
    s.previousCard = null;
    s.multiplier = 1.0;
    s.streak = 0;
    s.status = 'active';
    s.expiresAt = now + 15 * 60 * 1000;
    s.message = 'Wybierz Wyżej lub Niżej';
    return s;
  }

  // crash
  const bias = Number(rngCfg.specialBias) || 0;
  const u = rng(1_000_000) / 1_000_000;
  let crashAt = Math.min(50, Math.max(1, Math.floor((0.97 / (1 - u)) * 100) / 100));
  if (shouldForceWin(bias, rng) && crashAt < 2.2) {
    crashAt = 2.2 + (rng(400) / 100);
  } else if (shouldForceLoss(bias, rng) && crashAt > 1.45) {
    crashAt = 1.01 + (rng(35) / 100);
  }
  s.crashAt = Math.round(crashAt * 100) / 100;
  s.expiresAt = now + (Math.log(s.crashAt) / GROWTH) * 1000;
  s.status = 'active';
  s.message = 'Wypłać przed końcem lotu';
  return advance(s, now);
}

function advance(s, now = Date.now()) {
  if (s.status !== 'active') return s;
  // Old records without a deadline must not block an account indefinitely.
  if (!Number.isFinite(Number(s.expiresAt))) {
    const started = Number(s.startedAt);
    s.expiresAt = Number.isFinite(started) && started > 0 ? started + 15 * 60 * 1000 : now;
  }
  if (now >= Number(s.expiresAt)) {
    return settle(
      s,
      0,
      s.game === 'crash' && Number.isFinite(s.crashAt)
        ? `Koniec przy ×${s.crashAt.toFixed(2)}` : 'Upłynął czas — runda zakończona',
      s.eventMult || 1.0
    );
  }
  return s;
}

function action(s, actionName, now = Date.now()) {
  advance(s, now);
  if (s.status === 'settled') return s;
  if (actionName === 'abandon') {
    return settle(s, 0, 'Runda zakończona przez gracza. Stawka została utracona.');
  }
  const eventMult = s.eventMult || 1.0;

  if (s.game === 'crash') {
    if (actionName !== 'cashout') fail('Nieprawidłowy ruch.');
    s.cashoutMultiplier = Math.floor(Math.exp(((now - s.startedAt) / 1000) * GROWTH) * 100) / 100;
    return settle(s, Math.floor(s.bet * s.cashoutMultiplier), `Wypłata ×${s.cashoutMultiplier.toFixed(2)}`, eventMult);
  }

  if (s.game === 'blackjack') {
    if (!['hit', 'stand'].includes(actionName)) fail('Nieprawidłowy ruch.');
    if (actionName === 'hit') {
      s.player.push(s.deck.pop());
      if (score(s.player) > 21) return settle(s, 0, 'Przekroczone 21', eventMult);
      if (score(s.player) < 21) return s;
    }
    while (score(s.dealer) < 17) s.dealer.push(s.deck.pop());
    const p = score(s.player), d = score(s.dealer);
    return settle(
      s,
      p === d ? s.bet : d > 21 || p > d ? s.bet * 2 : 0,
      p === d ? 'Remis' : d > 21 || p > d ? 'Wygrana' : 'Wygrywa krupier',
      eventMult
    );
  }

  if (s.game === 'mines') {
    if (actionName === 'cashout') {
      if (!s.revealed || s.revealed.length === 0) fail('Odkryj co najmniej 1 pole.');
      return settle(s, Math.floor(s.bet * s.multiplier), `Wypłata ×${s.multiplier.toFixed(2)}`, eventMult);
    }
    const m = /^pick_(\d+)$/.exec(actionName);
    if (!m) fail('Nieprawidłowy ruch w Minach.');
    const idx = Number(m[1]);
    if (idx < 0 || idx > 15 || s.revealed.includes(idx)) fail('Pole już odkryte.');
    s.revealed.push(idx);
    if (s.bombs.includes(idx)) {
      s.explodedIndex = idx;
      return settle(s, 0, 'Trafiono na minę!', eventMult);
    }
    const stepFactor = s.bombsCount === 2 ? 1.16 : s.bombsCount === 4 ? 1.32 : 1.54;
    s.multiplier = Math.round(s.multiplier * stepFactor * 100) / 100;
    s.message = `Diament! ×${s.multiplier.toFixed(2)}`;
    if (s.revealed.length >= 16 - s.bombsCount) {
      return settle(s, Math.floor(s.bet * s.multiplier), `Wszystkie diamenty! ×${s.multiplier.toFixed(2)}`, eventMult);
    }
    return s;
  }

  if (s.game === 'hilo') {
    if (actionName === 'cashout') {
      if (!s.streak || s.streak < 1) fail('Odgadnij co najmniej 1 kartę.');
      return settle(s, Math.floor(s.bet * s.multiplier), `Wypłata ×${s.multiplier.toFixed(2)}`, eventMult);
    }
    if (!['higher', 'lower'].includes(actionName)) fail('Nieprawidłowy ruch w Hi-Lo.');
    const { lowM, highM } = hiloMultipliers(s.currentCard.rank);
    if (!s.deck || s.deck.length === 0) s.deck = deck();
    const nextCard = s.deck.pop();
    const prevRank = s.currentCard.rank;
    s.previousCard = s.currentCard;
    s.currentCard = nextCard;
    const won = actionName === 'higher' ? nextCard.rank >= prevRank : nextCard.rank <= prevRank;
    if (!won) {
      return settle(s, 0, `Pudło! Karta ${nextCard.rank}`, eventMult);
    }
    s.streak += 1;
    s.multiplier = Math.round(s.multiplier * (actionName === 'higher' ? highM : lowM) * 100) / 100;
    s.message = `Seria ${s.streak} (×${s.multiplier.toFixed(2)})`;
    return s;
  }

  fail('Ta gra nie ma kolejnych ruchów.');
}

function publicRound(id, s, now = Date.now()) {
  const r = {
    id, game: s.game, bet: s.bet, choice: s.choice,
    status: s.status, payout: s.payout, message: s.message,
    startedAt: s.startedAt, serverTime: now
  };
  for (const k of [
    'number', 'symbols', 'dice', 'bucket', 'segment', 'player',
    'cashoutMultiplier', 'revealed', 'bombsCount', 'explodedIndex',
    'currentCard', 'previousCard', 'streak', 'multiplier'
  ]) {
    if (s[k] !== undefined) r[k] = s[k];
  }
  if (s.dealer) {
    r.dealer = s.game === 'blackjack' && s.status === 'active' ? [s.dealer[0]] : s.dealer;
  }
  if (s.game === 'mines' && s.status === 'settled') {
    r.bombs = s.bombs;
  }
  if (s.game === 'crash') {
    r.multiplier = s.status === 'active'
      ? Math.floor(Math.exp((Math.max(0, now - s.startedAt) / 1000) * GROWTH) * 100) / 100
      : (s.cashoutMultiplier || s.crashAt);
    if (s.status === 'settled') r.crashAt = s.crashAt;
  }
  return r;
}

module.exports = {
  GAMES, RED, SLOT_MULTIPLIERS, PLINKO_MULTIPLIERS, WHEEL_SEGMENTS,
  GROWTH, fail, score, deck, validate, start, advance, action, publicRound
};
