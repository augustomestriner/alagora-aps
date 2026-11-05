import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hostname } from 'node:os';
import { hashPassword, verifyPassword, digest, issueSession, publicUser } from './auth.js';
import { sqlDistancia } from './risco.js';

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const photoSchema = z.string().max(850000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/).nullable().optional();
const reportSchema = z.object({
  id: z.uuid(), title: z.string().trim().min(5).max(100),
  description: z.string().trim().min(10).max(1500), address: z.string().trim().min(5).max(200),
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  severity: z.enum(['low','moderate','high']), photo: photoSchema
});
const patchSchema = z.object({ version: z.number().int().positive(), status: z.enum(['active','monitoring','resolved']), note: z.string().trim().min(5).max(500) });
const isoDate = z.string().refine(v => !Number.isNaN(Date.parse(v)), 'Data inválida');
const selectRain = `SELECT a.id,a.name,a.latitude,a.longitude,a.radius_m,round(s.rain_1h::numeric,1)::float AS rain_1h,round(s.rain_3h::numeric,1)::float AS rain_3h,round(s.rain_24h::numeric,1)::float AS rain_24h,round(s.forecast_3h::numeric,1)::float AS forecast_3h,s.open_reports,s.high_reports,COALESCE(s.risk,'none') AS risk,s.previous_risk,s.reasons,s.source,s.reference_hour,s.updated_at FROM rain_areas a LEFT JOIN rain_status s ON s.area_id=a.id`;
export const selectReport = `SELECT r.id,r.author_id,r.title,r.description,r.address,r.latitude,r.longitude,r.severity,r.status,r.version,r.is_demo,r.created_at,r.updated_at,u.name AS author_name,(r.photo IS NOT NULL) AS has_photo FROM reports r JOIN users u ON u.id=r.author_id`;

/**
 * Liga o canal do banco à central SSE desta instância: cada evento publicado por
 * qualquer processo (esta API, outra réplica ou o coletor) é reenviado aos aparelhos.
 */
export function ligarEventos(db, central) {
  return db.listen(async evento => {
    try {
      if (evento.tipo === 'report') {
        const { rows } = await db.query(`${selectReport} WHERE r.id=$1`, [evento.id]);
        if (rows[0]) central.publicar('report', rows[0]);
      } else if (evento.tipo === 'risk') {
        const { rows } = await db.query(`${selectRain} ORDER BY a.name`);
        central.publicar('risk', { areas: rows, changed: evento.areas || [] });
      }
    } catch (e) { console.error(`[eventos] falha ao repassar ${evento.tipo}: ${e.message}`); }
  }, { aoReconectar: () => central.publicar('resync', { motivo: 'canal reconectado' }) });
}

export function createApp(db, { corsOrigins = '', logger = true, central = null, instancia = `api@${hostname()}` } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req,res,next) => {
    res.set('X-Content-Type-Options','nosniff');
    res.set('Cache-Control','no-store');
    const allowed = corsOrigins.split(',').map(s=>s.trim());
    if (allowed.includes(req.headers.origin)) {
      res.set('Access-Control-Allow-Origin',req.headers.origin);
      res.set('Vary','Origin');
      res.set('Access-Control-Allow-Headers','Authorization,Content-Type');
      res.set('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');
    }
    if (req.method==='OPTIONS') return res.sendStatus(204);
    req.requestId = randomUUID();
    res.set('X-Request-Id',req.requestId);
    res.set('X-Instancia',instancia); // qual réplica da API atendeu
    next();
  });
  app.use(express.json({limit:'1mb'}));
  // Proteção de tentativas por endereço; o proxy conhecido é apenas o nginx do Compose.
  app.set('trust proxy', 1);
  const attempts = new Map();
  const throttle = (req,res,next) => {
    const key = req.ip;
    const now = Date.now();
    for (const [ip, item] of attempts) if (item.until < now) attempts.delete(ip);
    const item = attempts.get(key) || { count:0, until:now+60000 };
    item.count++; attempts.set(key,item);
    if (item.count>30) return res.status(429).json({error:'Muitas tentativas. Aguarde um minuto.'});
    next();
  };
  const auth = async (req,res,next) => {
    const token = req.headers.authorization?.replace(/^Bearer /,'');
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401,'Entre na sua conta para continuar.');
    const { rows } = await db.query('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()',[digest(token)]);
    if (!rows[0]) throw new HttpError(401,'Sua sessão expirou. Entre novamente.');
    req.user=rows[0]; req.token=token; next();
  };
  app.get('/api/health',async (req,res)=>{
    await db.query('SELECT 1');
    res.json({status:'ok',service:'alagora-api',instance:instancia,time:new Date().toISOString()});
  });
  // Tempo real (SSE). O aparelho mantém esta conexão aberta e recebe eventos
  // 'report' (ocorrência criada/alterada), 'risk' (risco de chuva) e 'resync'.
  app.get('/api/events',async (req,res)=>{
    if(!central) throw new HttpError(503,'Tempo real indisponível nesta instância.');
    const {rows}=await db.query('SELECT now() AS t');
    central.conectar(req,res,{serverTime:rows[0].t,instance:instancia});
  });
  app.post('/api/auth/register',throttle,async (req,res)=>{
    const body=z.object({name:z.string().trim().min(2).max(80),email:z.email().max(150),password:z.string().min(8).max(128)}).parse(req.body);
    const user={id:randomUUID(),name:body.name,email:body.email.toLowerCase(),role:'citizen'};
    try { await db.query('INSERT INTO users(id,name,email,password_hash) VALUES ($1,$2,$3,$4)',[user.id,user.name,user.email,await hashPassword(body.password)]); }
    catch(e) { if(e.code==='23505') throw new HttpError(409,'Este e-mail já está cadastrado.'); throw e; }
    res.status(201).json(await issueSession(db,user));
  });
  app.post('/api/auth/login',throttle,async (req,res)=>{
    const body=z.object({email:z.email().max(150),password:z.string().min(1).max(128)}).parse(req.body);
    const {rows}=await db.query('SELECT * FROM users WHERE email=$1',[body.email.toLowerCase()]);
    if(!rows[0] || !await verifyPassword(body.password,rows[0].password_hash)) throw new HttpError(401,'E-mail ou senha incorretos.');
    await db.query('DELETE FROM sessions WHERE expires_at<now()');
    res.json(await issueSession(db,rows[0]));
  });
  app.get('/api/auth/me',auth,(req,res)=>res.json({user:publicUser(req.user)}));
  app.post('/api/auth/logout',auth,async (req,res)=>{await db.query('DELETE FROM sessions WHERE token_hash=$1',[digest(req.token)]);res.sendStatus(204);});
  app.get('/api/reports',async (req,res)=>{
    const filters=z.object({status:z.enum(['active','monitoring','resolved']).optional(),severity:z.enum(['low','moderate','high']).optional(),q:z.string().max(150).optional(),mine:z.enum(['true','false']).optional(),since:isoDate.optional()}).parse(req.query);
    const args=[]; const clauses=[];
    if(filters.mine==='true') {
      const token=req.headers.authorization?.replace(/^Bearer /,'') || '';
      const {rows}=await db.query('SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()',[digest(token)]);
      if(!rows[0]) throw new HttpError(401,'Entre para consultar seus registros.');
      args.push(rows[0].user_id); clauses.push(`r.author_id=$${args.length}`);
    }
    for(const field of ['status','severity']) if(filters[field]) {args.push(filters[field]);clauses.push(`r.${field}=$${args.length}`);}
    if(filters.q) {args.push(`%${filters.q}%`);clauses.push(`(r.title ILIKE $${args.length} OR r.address ILIKE $${args.length})`);}
    // Sync delta: com `since`, devolve só o que foi criado/alterado depois desse instante.
    if(filters.since) {args.push(filters.since);clauses.push(`r.updated_at>$${args.length}::timestamptz`);}
    const now=(await db.query('SELECT now() AS t')).rows[0].t; // relógio do banco: o mesmo para todas as instâncias
    const {rows}=await db.query(`${selectReport}${clauses.length?' WHERE '+clauses.join(' AND '):''} ORDER BY ${filters.since?'r.updated_at ASC':'r.created_at DESC'} LIMIT 500`,args);
    res.json({reports:rows,serverTime:new Date(now).toISOString(),limit:500,delta:Boolean(filters.since)});
  });
  app.get('/api/reports/:id',async (req,res)=>{
    const id=z.uuid().parse(req.params.id);
    const {rows}=await db.query(`${selectReport} WHERE r.id=$1`,[id]);
    if(!rows[0]) throw new HttpError(404,'Ocorrência não encontrada.');
    const history=await db.query('SELECT h.from_status,h.to_status,h.note,h.version,h.created_at,u.name AS user_name FROM report_history h JOIN users u ON u.id=h.user_id WHERE h.report_id=$1 ORDER BY h.version DESC',[id]);
    res.json({report:rows[0],history:history.rows});
  });
  app.get('/api/reports/:id/photo',async (req,res)=>{
    const id=z.uuid().parse(req.params.id);
    const {rows}=await db.query('SELECT photo FROM reports WHERE id=$1',[id]);
    if(!rows[0]?.photo) throw new HttpError(404,'Foto não encontrada.');
    const [,mime,data]=rows[0].photo.match(/^data:(image\/(?:jpeg|png|webp));base64,(.*)$/);
    res.type(mime).send(Buffer.from(data,'base64'));
  });
  app.post('/api/reports',auth,async (req,res)=>{
    const body=reportSchema.parse(req.body);
    const hash=digest(JSON.stringify({...body,photo:body.photo??null}));
    const result=await db.transaction(async q=>{
      const inserted=await q(`INSERT INTO reports(id,author_id,title,description,address,latitude,longitude,severity,photo,payload_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING RETURNING id`,[body.id,req.user.id,body.title,body.description,body.address,body.latitude,body.longitude,body.severity,body.photo??null,hash]);
      if(!inserted.rows.length) {
        const previous=(await q('SELECT author_id,payload_hash FROM reports WHERE id=$1',[body.id])).rows[0];
        if(previous.author_id!==req.user.id || previous.payload_hash!==hash) throw new HttpError(409,'Este identificador já foi usado para outro registro.');
        return {replayed:true};
      }
      await q("INSERT INTO report_history(id,report_id,user_id,to_status,note,version) VALUES ($1,$2,$3,'active','Ocorrência registrada.',1)",[randomUUID(),body.id,req.user.id]);
      await q.notify({tipo:'report',id:body.id,acao:'created'}); // entregue só após o COMMIT
      return {replayed:false};
    });
    const {rows}=await db.query(`${selectReport} WHERE r.id=$1`,[body.id]);
    res.status(result.replayed?200:201).json({report:rows[0],...result});
  });
  app.patch('/api/reports/:id/status',auth,async (req,res)=>{
    const id=z.uuid().parse(req.params.id); const body=patchSchema.parse(req.body);
    await db.transaction(async q=>{
      const {rows}=await q('SELECT author_id,status,version FROM reports WHERE id=$1 FOR UPDATE',[id]);
      const report=rows[0];
      if(!report) throw new HttpError(404,'Ocorrência não encontrada.');
      if(report.author_id!==req.user.id && req.user.role!=='admin') throw new HttpError(403,'Somente o autor ou a gestão pode atualizar esta ocorrência.');
      if(report.version!==body.version) throw new HttpError(409,'Outra pessoa atualizou esta ocorrência. Confira a situação atual e tente novamente.',{currentVersion:report.version});
      if(report.status===body.status) throw new HttpError(422,'Selecione uma situação diferente da atual.');
      await q('UPDATE reports SET status=$1,version=version+1,updated_at=now() WHERE id=$2',[body.status,id]);
      await q('INSERT INTO report_history(id,report_id,user_id,from_status,to_status,note,version) VALUES ($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),id,req.user.id,report.status,body.status,body.note,body.version+1]);
      await q.notify({tipo:'report',id,acao:'status'});
    });
    const {rows}=await db.query(`${selectReport} WHERE r.id=$1`,[id]);res.json({report:rows[0]});
  });
  // ----- Chuva e risco (dados do serviço coletor) -----
  app.get('/api/rain',async (req,res)=>{
    const {rows}=await db.query(`${selectRain} ORDER BY a.name`);
    const coletor=(await db.query("SELECT name,last_seen,interval_s,details,extract(epoch FROM now()-last_seen)::float AS age_s FROM services WHERE kind='collector' ORDER BY last_seen DESC LIMIT 1")).rows[0]||null;
    res.json({areas:rows,collector:coletor&&{...coletor,healthy:coletor.age_s<=coletor.interval_s*2.5+5}});
  });
  app.get('/api/rain/:id/history',async (req,res)=>{
    const id=z.string().regex(/^[a-z0-9-]{2,40}$/).parse(req.params.id);
    const {horas}=z.object({horas:z.coerce.number().int().min(1).max(72).default(24)}).parse(req.query);
    const area=await db.query('SELECT id,name FROM rain_areas WHERE id=$1',[id]);
    if(!area.rows[0]) throw new HttpError(404,'Área não encontrada.');
    const {rows}=await db.query(`SELECT hour,round(precipitation_mm::numeric,1)::float AS precipitation_mm,forecast,source FROM rain_hourly WHERE area_id=$1 AND hour>now()-($2::int*interval '1 hour') ORDER BY hour`,[id,horas]);
    res.json({area:area.rows[0],hours:rows});
  });
  // Georreferenciamento: ocorrências em aberto num raio e áreas mais próximas de um ponto.
  app.get('/api/nearby',async (req,res)=>{
    const p=z.object({lat:z.coerce.number().min(-90).max(90),lng:z.coerce.number().min(-180).max(180),radius:z.coerce.number().int().min(100).max(20000).default(2000)}).parse(req.query);
    const dist=sqlDistancia('$1','$2','r.latitude','r.longitude');
    // Caixa delimitadora antes da fórmula exata: descarta rápido o que está longe.
    const dLat=p.radius/111320, dLng=p.radius/(111320*Math.max(0.01,Math.cos(p.lat*Math.PI/180)));
    const reports=await db.query(`SELECT * FROM (SELECT r.id,r.title,r.address,r.latitude,r.longitude,r.severity,r.status,r.version,r.is_demo,r.created_at,r.updated_at,${dist} AS distance_m FROM reports r
      WHERE r.status<>'resolved' AND r.latitude BETWEEN $3 AND $4 AND r.longitude BETWEEN $5 AND $6) x WHERE distance_m<=$7 ORDER BY distance_m LIMIT 50`,
      [p.lat,p.lng,p.lat-dLat,p.lat+dLat,p.lng-dLng,p.lng+dLng,p.radius]);
    const areas=await db.query(`SELECT * FROM (${selectRain}) a2 ORDER BY ${sqlDistancia('$1','$2','a2.latitude','a2.longitude')} LIMIT 3`,[p.lat,p.lng]);
    res.json({point:{lat:p.lat,lng:p.lng},radius:p.radius,reports:reports.rows,areas:areas.rows.map(a=>({...a,distance_m:Math.round(haversine(p.lat,p.lng,a.latitude,a.longitude))}))});
  });
  // Observabilidade: batimentos dos serviços (API e coletor) gravados no banco.
  app.get('/api/status',async (req,res)=>{
    const {rows}=await db.query("SELECT name,kind,started_at,last_seen,interval_s,details,extract(epoch FROM now()-last_seen)::float AS age_s FROM services WHERE last_seen>now()-interval '1 hour' ORDER BY kind,name");
    res.json({serverTime:new Date().toISOString(),instance:instancia,sseClients:central?.total??0,services:rows.map(s=>({...s,healthy:s.age_s<=s.interval_s*2.5+5}))});
  });
  // Comando de demonstração (somente gestão): pede ao coletor para usar a simulação de tempestade.
  app.post('/api/admin/simulation',auth,async (req,res)=>{
    if(req.user.role!=='admin') throw new HttpError(403,'Somente a gestão pode controlar a simulação.');
    const {active}=z.object({active:z.boolean()}).parse(req.body);
    await db.notify({tipo:'command',comando:'simulacao',ativo:active,por:req.user.name});
    res.status(202).json({accepted:true,active});
  });
  app.use((req,res)=>res.status(404).json({error:'Recurso não encontrado.'}));
  app.use((error,req,res,next)=>{
    if(error instanceof z.ZodError) return res.status(400).json({error:'Confira os campos informados.',fields:error.issues.map(i=>({field:i.path.join('.'),message:i.message}))});
    if(error.type==='entity.too.large') return res.status(413).json({error:'A imagem excede o limite permitido.'});
    if(error instanceof SyntaxError && error.status===400) return res.status(400).json({error:'JSON inválido.'});
    if(error.status) return res.status(error.status).json({error:error.message,...error.extra});
    if(logger) console.error(JSON.stringify({requestId:req.requestId,message:error.message,code:error.code}));
    res.status(503).json({error:'Serviço indisponível. Tente novamente em instantes.',requestId:req.requestId});
  });
  return app;
}

function haversine(lat1,lon1,lat2,lon2){const R=6371000,r=Math.PI/180;const a=Math.sin((lat2-lat1)*r/2)**2+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin((lon2-lon1)*r/2)**2;return 2*R*Math.asin(Math.sqrt(a));}
