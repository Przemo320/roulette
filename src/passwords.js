'use strict';
const {scrypt,randomBytes,createHash,timingSafeEqual}=require('node:crypto');
const {promisify}=require('node:util');
const derive=promisify(scrypt);
const {fail}=require('./games');
const options={N:131072,r:8,p:1,maxmem:256*1024*1024};
let busy=0;
async function guarded(fn) { if(busy>=2) fail('Serwer logowania jest zajęty. Spróbuj za chwilę.',503); busy++; try{return await fn();}finally{busy--;} }
function sha(value){return createHash('sha256').update(value).digest('hex');}
function equal(a,b){const x=Buffer.from(a,'hex'),y=Buffer.from(b,'hex');return x.length===y.length&&timingSafeEqual(x,y);}
async function hash(password){
  return guarded(async()=>{const salt=randomBytes(16).toString('hex');const key=await derive(password,salt,64,options);return `scrypt$${salt}$${key.toString('hex')}`;});
}
async function verify(password,stored){
  if(/^[0-9a-f]{64}$/.test(stored)) return equal(sha(password.trim()),stored); // migracja starej wersji
  const [type,salt,key]=stored.split('$'); if(type!=='scrypt'||!salt||!key)return false;
  return guarded(async()=>equal((await derive(password,salt,64,options)).toString('hex'),key));
}
module.exports={hash,verify,sha};
