'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes,randomUUID}=require('node:crypto');
const fs=require('node:fs');const path=require('node:path');
const {createApp,today}=require('../src/app');const {sha}=require('../src/passwords');
let pool,server,base,db;
// PGlite uruchamia rzeczywisty silnik PostgreSQL w WASM. Pula serializuje połączenia;
// do testu blokad na wielu połączeniach ustaw TEST_DATABASE_URL na OSOBNĄ pustą bazę.
async function embeddedPool(){
  const {PGlite}=require('@electric-sql/pglite');db=new PGlite();await db.waitReady;
  let tail=Promise.resolve();
  async function connect(){let release;const previous=tail;tail=new Promise(resolve=>{release=resolve});await previous;
    return {query:async(sql,args)=>args?db.query(sql,args):(['BEGIN','COMMIT','ROLLBACK'].includes(sql)?db.query(sql):db.query(sql)),release};}
  return {connect,query:async(sql,args)=>{const c=await connect();try{return await c.query(sql,args);}finally{c.release();}},end:()=>db.close()};
}
before(async()=>{
  if(process.env.TEST_DATABASE_URL){pool=new(require('pg').Pool)({connectionString:process.env.TEST_DATABASE_URL});}
  else pool=await embeddedPool();
  const schema=fs.readFileSync(path.join(__dirname,'../src/schema.sql'),'utf8');
  if(db)await db.exec(schema);else await pool.query(schema);
  server=createApp(pool,{publicUrl:'http://localhost:3000'}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));if(pool)await pool.end();});
async function user(){const nick='T'+randomBytes(4).toString('hex').toUpperCase();const token=randomBytes(32).toString('hex');
  await pool.query('INSERT INTO players(nick,password_hash,credits,last_bonus_date) VALUES($1,$2,10000,$3)',[nick,sha('legacy-secret'),today()]);
  await pool.query("INSERT INTO casino_sessions(token_hash,nick,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 day')",[sha(token),nick]);return {nick,token};}
async function api(url,method='GET',body,token){const res=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return {status:res.status,json:await res.json()};}
test('No unauthenticated rounds; legacy balance write disabled',async()=>{
  assert.equal((await api('/api/rounds','POST',{})).status,401);
  assert.equal((await api('/sync','POST',{credits:999999})).status,410);
});
test('Duplicate request charged once, even simultaneous retries; changed body conflicts',async()=>{
  const u=await user();const body={requestId:randomUUID(),game:'roulette',bet:100,choice:'RED'};
  const [a,b]=await Promise.all([api('/api/rounds','POST',body,u.token),api('/api/rounds','POST',body,u.token)]);
  assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.json.round.id,b.json.round.id);
  const p=(await api('/api/me','GET',null,u.token)).json;
  assert.equal(p.credits,10000-100+a.json.round.payout);assert.equal(p.stats.rounds,1);
  assert.equal((await api('/api/rounds','POST',{...body,bet:50},u.token)).status,409);
});
test('Daily bonus is granted once under concurrent requests',async()=>{
  const u=await user();await pool.query("UPDATE players SET last_bonus_date='2000-01-01' WHERE nick=$1",[u.nick]);
  const results=await Promise.all(Array.from({length:5},()=>api('/api/me','GET',null,u.token)));
  assert.equal(results.filter(x=>x.json.bonusGranted).length,1);
  assert.equal((await api('/api/me','GET',null,u.token)).json.credits,11000);
});
test('Parallel bets cannot spend more than the balance',async()=>{
  const u=await user();await pool.query('UPDATE players SET credits=25 WHERE nick=$1',[u.nick]);
  // Active blackjack prevents a second round even if the first would otherwise win immediately.
  const attempts=await Promise.all(Array.from({length:5},()=>api('/api/rounds','POST',{requestId:randomUUID(),game:'dice',bet:500,choice:'OVER_7'},u.token)));
  assert(attempts.every(x=>x.status===409));assert.equal((await api('/api/me','GET',null,u.token)).json.credits,25);
});
test('A client supplied credits field never becomes the balance',async()=>{
  const u=await user();const r=await api('/api/rounds','POST',{requestId:randomUUID(),game:'slots',bet:50,credits:888888888},u.token);
  assert.equal(r.status,200);assert.equal(r.json.credits,9950+r.json.round.payout);
});
test('Racing valid bets preserve the ledger and cannot overdraw',async()=>{
  const u=await user();await pool.query('UPDATE players SET credits=500 WHERE nick=$1',[u.nick]);
  const results=await Promise.all(Array.from({length:10},()=>api('/api/rounds','POST',{requestId:randomUUID(),game:'roulette',bet:500,choice:'ZERO'},u.token)));
  assert(results.every(r=>[200,409].includes(r.status)));
  const completed=results.filter(r=>r.status===200);assert(completed.length>=1);
  const expected=500+completed.reduce((sum,r)=>sum+r.json.round.payout-500,0);
  const current=(await api('/api/me','GET',null,u.token)).json;
  assert.equal(current.credits,expected);assert(current.credits>=0);assert.equal(current.stats.rounds,completed.length);
});
test('Blackjack actions idempotent; opponent cannot access round; only one active round',async()=>{
  const u=await user(),other=await user();let start;
  for(let i=0;i<30;i++){start=await api('/api/rounds','POST',{requestId:randomUUID(),game:'blackjack',bet:25},u.token);if(start.json.round.status==='active')break;}
  assert.equal(start.json.round.status,'active');assert.equal(start.json.round.dealer.length,1);assert.equal(start.json.round.deck,undefined);
  const id=start.json.round.id;assert.equal((await api('/api/rounds/'+id,'GET',null,other.token)).status,404);
  assert.equal((await api('/api/rounds','POST',{requestId:randomUUID(),game:'dice',bet:25,choice:'OVER_7'},u.token)).status,409);
  const body={requestId:randomUUID(),action:'stand'};
  const [a,b]=await Promise.all([api('/api/rounds/'+id+'/actions','POST',body,u.token),api('/api/rounds/'+id+'/actions','POST',body,u.token)]);
  assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.json.credits,b.json.credits);
  assert.equal(a.json.round.status,'settled');assert.equal(a.json.credits,start.json.credits+a.json.round.payout);
});
test('Crash expired on server: no payout after app suspension; private cutoff stays hidden',async()=>{
  const u=await user();let r;
  for(let i=0;i<30;i++){r=await api('/api/rounds','POST',{requestId:randomUUID(),game:'crash',bet:25},u.token);if(r.json.round.status==='active')break;}
  assert.equal(r.json.round.status,'active');assert.equal(r.json.round.crashAt,undefined);assert.equal(r.json.round.expiresAt,undefined);
  const id=r.json.round.id;
  await pool.query("UPDATE casino_rounds SET state=jsonb_set(state,'{expiresAt}','0'::jsonb) WHERE id=$1",[id]);
  const done=await api('/api/rounds/'+id+'/actions','POST',{requestId:randomUUID(),action:'cashout'},u.token);
  assert.equal(done.json.round.payout,0);assert.equal(done.json.round.status,'settled');assert.equal(done.json.credits,r.json.credits);
});
test('Device flow, legacy password migration, poll retry and session revocation',async()=>{
  const u=await user();const d=(await api('/api/device/start','POST',{})).json;
  assert.equal((await api('/api/device/poll','POST',{deviceSecret:d.deviceSecret})).json.pending,true);
  const bad=await fetch(base+'/api/device/approve',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://attacker.invalid'},body:JSON.stringify({code:d.userCode,nick:u.nick,password:'legacy-secret',mode:'login'})});assert.equal(bad.status,403);
  const approved=await fetch(base+'/api/device/approve',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:3000'},body:JSON.stringify({code:d.userCode,nick:u.nick,password:'legacy-secret',mode:'login'})});assert.equal(approved.status,200);
  const a=(await api('/api/device/poll','POST',{deviceSecret:d.deviceSecret})).json;
  const b=(await api('/api/device/poll','POST',{deviceSecret:d.deviceSecret})).json;assert.equal(a.token,b.token);
  assert.equal((await api('/api/me','GET',null,a.token)).json.nick,u.nick);
  const p=(await pool.query('SELECT * FROM players WHERE nick=$1',[u.nick])).rows[0];assert.match(p.password_hash,/^scrypt\$/);
  await api('/api/logout','POST',{},a.token);assert.equal((await api('/api/me','GET',null,a.token)).status,401);
  assert.equal((await api('/api/device/poll','POST',{deviceSecret:d.deviceSecret})).status,401);
});
