'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const g=require('../src/games');
test('Roulette: 37 equal outcomes; red/black 18, zero 1; refunds include stake',()=>{
  for(const [choice,wins] of [['RED',18],['BLACK',18],['ZERO',1]]){
    let found=0;
    for(let n=0;n<37;n++){const r=g.start('roulette',25,choice,0,()=>n);if(r.payout)found++;assert.equal(r.number,n);}
    assert.equal(found,wins);
  }
});
test('Slots: enumerate every combination, RTP 90.4%; pair refunds stake',()=>{
  let sum=0;
  for(let a=0;a<5;a++)for(let b=0;b<5;b++)for(let c=0;c<5;c++){
    const values=[a,b,c];sum+=g.start('slots',100,'',0,()=>values.shift()).payout;
  }
  assert.equal(sum/125,90.4);
});
test('Dice: all 36 outcomes, seven never wins under/over',()=>{
  for(const [choice,count] of [['UNDER_7',15],['LUCKY_7',6],['OVER_7',15]]){
    let wins=0;
    for(let a=0;a<6;a++)for(let b=0;b<6;b++){const q=[a,b];if(g.start('dice',100,choice,0,()=>q.shift()).payout)wins++;}
    assert.equal(wins,count);
  }
});
test('Plinko: published bucket distribution and RTP 96%',()=>{
  let total=0;const counts=[0,0,0,0,0];for(let i=0;i<100;i++){const r=g.start('plinko',100,'',0,()=>i);counts[r.bucket]++;total+=r.payout;}
  assert.deepEqual(counts,[2,16,64,16,2]);assert.equal(total/100,96);
});
test('Blackjack: aces, soft 17 stands, ties refund, dealer hole card and deck stay private',()=>{
  const card=rank=>({rank,suit:0});assert.equal(g.score([card(1),card(1),card(9)]),21);
  const s={game:'blackjack',bet:100,choice:'',status:'active',payout:0,expiresAt:99999,startedAt:0,
    player:[card(10),card(7)],dealer:[card(1),card(6)],deck:[card(10)]};
  const pub=g.publicRound('id',s,0);assert.equal(pub.dealer.length,1);assert.equal(pub.deck,undefined);assert.equal(pub.expiresAt,undefined);
  g.action(s,'stand',1);assert.equal(s.payout,100);assert.equal(s.dealer.length,2);assert.equal(s.status,'settled');
});
test('Blackjack: bust and expired hand lose; repeated settled action has no extra payout',()=>{
  const s={game:'blackjack',bet:50,status:'active',payout:0,expiresAt:100,player:[{rank:10},{rank:9}],dealer:[{rank:10},{rank:7}],deck:[{rank:5}]};
  g.action(s,'hit',1);assert.equal(s.payout,0);assert.equal(s.status,'settled');g.action(s,'hit',2);assert.equal(s.player.length,3);
  const expired={...s,status:'active'};g.advance(expired,100);assert.equal(expired.status,'settled');
});
test('Blackjack naturals: both 21 tie, player-only natural pays 3:2 with floor rounding',()=>{
  const both=g.start('blackjack',25,'',0,n=>({52:0,51:9,50:13,49:22}[n]??n-1));
  assert.equal(both.payout,25);assert.equal(both.message,'Remis');
  const player=g.start('blackjack',25,'',0,n=>({52:0,51:9,50:1,49:4}[n]??n-1));
  assert.equal(player.payout,62);assert.equal(player.message,'Blackjack 3:2');
});
test('Crash: cutoff never disclosed while active; late cashout loses; early cashout pays once',()=>{
  const s=g.start('crash',100,'',0,()=>500000);assert.equal(s.status,'active');assert.equal(s.crashAt,1.94);
  const p=g.publicRound('id',s,1);assert.equal(p.crashAt,undefined);assert.equal(p.expiresAt,undefined);
  const late=structuredClone(s);g.action(late,'cashout',s.expiresAt);assert.equal(late.payout,0);
  g.action(s,'cashout',1000);assert.equal(s.payout,129);g.action(s,'cashout',2000);assert.equal(s.payout,129);
});
test('Crash: immediate crash and maximum cap',()=>{
  assert.equal(g.start('crash',100,'',0,()=>0).status,'settled');
  assert.equal(g.start('crash',100,'',0,()=>999999).crashAt,50);
});
test('Inputs: fractional / negative / huge bets, invalid game and choice rejected',()=>{
  for(const n of [-1,0,0.5,501,NaN,Infinity,'100'])assert.throws(()=>g.start('dice',n,'LUCKY_7'));
  assert.throws(()=>g.start('hacked',50,''));assert.throws(()=>g.start('roulette',50,'ANY'));
});
