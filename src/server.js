'use strict';
const {Pool}=require('pg');
const fs=require('node:fs');
const path=require('node:path');
const {createApp,transaction}=require('./app');
async function main(){
  if(!process.env.DATABASE_URL)throw new Error('Ustaw DATABASE_URL.');
  if(!process.env.PUBLIC_URL)throw new Error('Ustaw PUBLIC_URL.');
  const publicUrl=new URL(process.env.PUBLIC_URL);
  if(!['https:','http:'].includes(publicUrl.protocol))throw new Error('PUBLIC_URL musi być adresem HTTP(S).');
  if(publicUrl.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(publicUrl.hostname))throw new Error('Publiczny serwer wymaga HTTPS.');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:10,connectionTimeoutMillis:10000,
    ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:process.env.DB_SSL_REJECT_UNAUTHORIZED!=='false'}:false});
  pool.on('error',err=>console.error('PostgreSQL:',err.code||err.name));
  await transaction(pool,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(641993204)');
    await c.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
  });
  const server=createApp(pool).listen(Number(process.env.PORT||3000),()=>console.log('Casino Wear v2 ready'));
  const timer=setInterval(async()=>{
    try{
      await pool.query('DELETE FROM casino_devices WHERE expires_at<NOW()');
      await pool.query('DELETE FROM casino_sessions WHERE expires_at<NOW()');
    }catch(err){console.error('Cleanup:',err.code||err.name);}
  },60*60000);timer.unref();
  async function stop(){clearInterval(timer);server.close(async()=>{await pool.end();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
main().catch(err=>{console.error('Startup failed:',err.code||err.message);process.exit(1);});
