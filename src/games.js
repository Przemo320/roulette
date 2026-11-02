'use strict';
const { randomInt } = require('node:crypto');
const GAMES = ['roulette', 'slots', 'dice', 'blackjack', 'crash', 'plinko'];
const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const SLOT_MULTIPLIERS = [25,12,8,5,3];
const PLINKO_MULTIPLIERS = [8,2,0,2,8];
const GROWTH = 0.26;
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function score(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { total += c.rank === 1 ? 11 : Math.min(c.rank, 10); if (c.rank === 1) aces++; }
  while (total > 21 && aces-- > 0) total -= 10;
  return total;
}
function deck(rng = randomInt) {
  const cards = Array.from({length:52}, (_,i) => ({rank:i%13+1, suit:Math.floor(i/13)}));
  for (let i=51; i>0; i--) { const j=rng(i+1); [cards[i],cards[j]]=[cards[j],cards[i]]; }
  return cards;
}
function validate(game, bet, choice) {
  if (!GAMES.includes(game)) fail('Nieznana gra.');
  if (!Number.isSafeInteger(bet) || bet < 1 || bet > 500) fail('Stawka musi być całkowita: 1–500.');
  if (typeof choice!=='string' || choice.length>16) fail('Nieprawidłowy wybór.');
  if (!['roulette','dice'].includes(game) && choice!=='') fail('Ta gra nie przyjmuje wyboru zakładu.');
  if (game === 'roulette' && !['RED','BLACK','ZERO'].includes(choice)) fail('Nieprawidłowy zakład ruletki.');
  if (game === 'dice' && !['UNDER_7','LUCKY_7','OVER_7'].includes(choice)) fail('Nieprawidłowy zakład kości.');
}
function settle(s, payout, message) { s.status='settled'; s.payout=payout; s.message=message; return s; }
function start(game, bet, choice, now = Date.now(), rng = randomInt) {
  validate(game,bet,choice);
  const s={game,bet,choice:choice||'',status:'settled',payout:0,startedAt:now,message:''};
  if (game==='roulette') {
    s.number=rng(37);
    const won=choice==='ZERO' ? s.number===0 : s.number!==0 && (choice==='RED')===RED.has(s.number);
    return settle(s,won ? bet*(choice==='ZERO'?36:2):0,`Wypadło ${s.number}`);
  }
  if (game==='slots') {
    // 5 symboli po 20%. Tabela wypłat jest stała, bez zmiany wyniku po losowaniu.
    s.symbols=[rng(5),rng(5),rng(5)];
    const [a,b,c]=s.symbols;
    const mult=a===b && b===c ? SLOT_MULTIPLIERS[a] : a===b || b===c || a===c ? 1 : 0;
    return settle(s,bet*mult,`Automat ×${mult}`);
  }
  if (game==='dice') {
    s.dice=[rng(6)+1,rng(6)+1]; const sum=s.dice[0]+s.dice[1];
    const won=choice==='UNDER_7'?sum<7:choice==='OVER_7'?sum>7:sum===7;
    return settle(s,won?bet*(choice==='LUCKY_7'?4:2):0,`Suma ${sum}`);
  }
  if (game==='plinko') {
    // Jawny rozkład koszyków: 2%, 16%, 64%, 16%, 2%. RTP 96%.
    const r=rng(100); s.bucket=r<2?0:r<18?1:r<82?2:r<98?3:4;
    return settle(s,bet*PLINKO_MULTIPLIERS[s.bucket],`Koszyk ×${PLINKO_MULTIPLIERS[s.bucket]}`);
  }
  if (game==='blackjack') {
    s.deck=deck(rng); s.player=[s.deck.pop(),s.deck.pop()]; s.dealer=[s.deck.pop(),s.deck.pop()];
    const p=score(s.player),d=score(s.dealer);
    if (p===21 || d===21) return settle(s,p===d?bet:p===21?Math.floor(bet*2.5):0,p===d?'Remis':p===21?'Blackjack 3:2':'Blackjack krupiera');
    s.status='active'; s.expiresAt=now+15*60*1000; s.message='Dobierz albo pasuj'; return s;
  }
  const u=rng(1_000_000)/1_000_000;
  s.crashAt=Math.min(50,Math.max(1,Math.floor(0.97/(1-u)*100)/100));
  s.expiresAt=now+Math.log(s.crashAt)/GROWTH*1000;
  s.status='active'; s.message='Wypłać przed końcem lotu';
  return advance(s,now);
}
function advance(s, now=Date.now()) {
  if (s.status==='active' && now>=s.expiresAt) return settle(s,0,s.game==='crash'?`Koniec przy ×${s.crashAt.toFixed(2)}`:'Upłynęło 15 minut — runda zakończona');
  return s;
}
function action(s, actionName, now=Date.now()) {
  if (s.game==='blackjack' && !['hit','stand'].includes(actionName)) fail('Nieprawidłowy ruch.');
  if (s.game==='crash' && actionName!=='cashout') fail('Nieprawidłowy ruch.');
  if (!['blackjack','crash'].includes(s.game)) fail('Ta gra nie ma kolejnych ruchów.');
  advance(s,now); if (s.status==='settled') return s;
  if (s.game==='crash') {
    s.cashoutMultiplier=Math.floor(Math.exp((now-s.startedAt)/1000*GROWTH)*100)/100;
    return settle(s,Math.floor(s.bet*s.cashoutMultiplier),`Wypłata ×${s.cashoutMultiplier.toFixed(2)}`);
  }
  if (actionName==='hit') {
    s.player.push(s.deck.pop());
    if (score(s.player)>21) return settle(s,0,'Przekroczone 21');
    if (score(s.player)<21) return s;
  }
  // Krupier stoi również na miękkim 17. Brak split / double / insurance.
  while (score(s.dealer)<17) s.dealer.push(s.deck.pop());
  const p=score(s.player),d=score(s.dealer);
  return settle(s,p===d?s.bet:d>21||p>d?s.bet*2:0,p===d?'Remis':d>21||p>d?'Wygrana':'Wygrywa krupier');
}
function publicRound(id,s,now=Date.now()) {
  const r={id,game:s.game,bet:s.bet,choice:s.choice,status:s.status,payout:s.payout,
    message:s.message,startedAt:s.startedAt,serverTime:now};
  for(const k of ['number','symbols','dice','bucket','player','cashoutMultiplier']) if(s[k]!==undefined) r[k]=s[k];
  if(s.dealer) r.dealer=s.status==='active'?[s.dealer[0]]:s.dealer;
  if(s.game==='crash') {
    r.multiplier=s.status==='active'?Math.floor(Math.exp(Math.max(0,now-s.startedAt)/1000*GROWTH)*100)/100:(s.cashoutMultiplier||s.crashAt);
    if(s.status==='settled') r.crashAt=s.crashAt;
  }
  return r; // Nigdy nie ujawniaj talii, expiresAt ani aktywnego crashAt.
}
module.exports={GAMES,RED,SLOT_MULTIPLIERS,PLINKO_MULTIPLIERS,GROWTH,fail,score,deck,validate,start,advance,action,publicRound};
