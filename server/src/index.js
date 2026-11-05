import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.js';
import { createApp, ligarEventos } from './app.js';
import { seedDemo } from './seed.js';
import { CentralEventos } from './realtime.js';
import { Coletor, garantirAreas, registrarBatimento } from './coletor.js';

const local = process.env.LOCAL_DB==='true';
const db=await createDatabase({local,path:local?process.env.LOCAL_DB_PATH||'./.local-db':undefined});
if(process.env.SEED_DEMO==='true') await seedDemo(db);
await garantirAreas(db);

const instancia=`api@${hostname()}`;
const central=new CentralEventos();
const pararEventos=ligarEventos(db,central);
const app=createApp(db,{corsOrigins:process.env.CORS_ORIGINS||'http://localhost,https://localhost,capacitor://localhost',central,instancia});
const port=Number(process.env.PORT)||3000;
const server=app.listen(port,'0.0.0.0',()=>console.log(`Alagora API (${instancia}): porta ${port}; banco ${local?'PGlite local':'PostgreSQL'}`));

// Batimento da API: a tela de status mostra quais instâncias estão vivas.
const inicio=new Date().toISOString();
const batimento=()=>registrarBatimento(db,instancia,'api',10,{iniciada_em:inicio,clientes_tempo_real:central.total,eventos_enviados:central.enviados,ultimo_evento:central.ultimoEvento,banco:local?'PGlite':'PostgreSQL'}).catch(e=>console.warn(`[api] batimento falhou: ${e.message}`));
batimento();const timer=setInterval(batimento,10_000);

// No modo local (PGlite, sem Docker) o coletor roda dentro do mesmo processo,
// pois o banco embutido não aceita conexões de outro processo.
let coletor=null;
if(local&&process.env.COLETOR_EMBUTIDO!=='false'){
  coletor=new Coletor(db,{fonte:process.env.COLETOR_FONTE||'auto',intervaloS:Number(process.env.COLETOR_INTERVALO_S)||120,arquivoReplay:fileURLToPath(new URL('../replay/chuva-jundiai.json',import.meta.url))});
  coletor.iniciar();
}

async function stop(){clearInterval(timer);coletor?.parar();pararEventos?.();central.fechar();server.close(async()=>{await db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
