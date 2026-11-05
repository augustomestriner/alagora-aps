import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {createDatabase} from '../src/db.js';
import {createApp} from '../src/app.js';
import {seedDemo} from '../src/seed.js';
let db,app,token,secondToken,adminToken,ownerId;
const auth=token=>({Authorization:`Bearer ${token}`});
const input=()=>({id:randomUUID(),title:'Alagamento de teste',description:'Água acumulada sobre parte da pista.',address:'Rua de teste, Jundiaí',latitude:-23.19,longitude:-46.89,severity:'high',photo:null});
before(async()=>{
  db=await createDatabase({local:process.env.TEST_POSTGRES!=='true'});
  app=createApp(db,{logger:false});
  const email=`owner-${randomUUID()}@teste.local`;
  const r=await request(app).post('/api/auth/register').send({name:'Autor teste',email,password:'Teste@12345'}).expect(201);
  token=r.body.token;ownerId=r.body.user.id;
  const s=await request(app).post('/api/auth/register').send({name:'Outro teste',email:`other-${randomUUID()}@teste.local`,password:'Teste@12345'}).expect(201);secondToken=s.body.token;
  await db.query("UPDATE users SET role='admin' WHERE id=$1",[s.body.user.id]);
  const admin=await request(app).post('/api/auth/login').send({email:s.body.user.email,password:'Teste@12345'}).expect(200);adminToken=admin.body.token;
});
after(async()=>{await db.close();});
test('saúde, validação e credenciais incorretas',async()=>{
  await request(app).get('/api/health').expect(200);
  await request(app).post('/api/auth/login').send({email:'invalido',password:'x'}).expect(400);
  await request(app).post('/api/auth/login').send({email:'naoexiste@teste.local',password:'x'}).expect(401);
  await request(app).post('/api/reports').send(input()).expect(401);
  await request(app).get('/api/reports/nao-e-uuid').expect(400);
});
test('criação atômica, repetição idempotente e chave com conteúdo diferente',async()=>{
  const body=input();
  const first=await request(app).post('/api/reports').set(auth(token)).send(body).expect(201);
  assert.equal(first.body.report.author_id,ownerId);
  const repeat=await request(app).post('/api/reports').set(auth(token)).send(body).expect(200);
  assert.equal(repeat.body.replayed,true);
  await request(app).post('/api/reports').set(auth(token)).send({...body,title:'Outro conteúdo com mesma chave'}).expect(409);
  const detail=await request(app).get(`/api/reports/${body.id}`).expect(200);
  assert.equal(detail.body.history.length,1);
});
test('dois reenvios simultâneos produzem um registro e um histórico',async()=>{
  const body=input();
  const results=await Promise.all([request(app).post('/api/reports').set(auth(token)).send(body),request(app).post('/api/reports').set(auth(token)).send(body)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
  const count=await db.query('SELECT count(*) AS n FROM report_history WHERE report_id=$1',[body.id]);assert.equal(Number(count.rows[0].n),1);
});
test('controle de concorrência rejeita uma atualização com versão antiga',async()=>{
  const body=input();await request(app).post('/api/reports').set(auth(token)).send(body).expect(201);
  const updates=await Promise.all([
    request(app).patch(`/api/reports/${body.id}/status`).set(auth(token)).send({version:1,status:'monitoring',note:'Equipe acompanhando o ponto.'}),
    request(app).patch(`/api/reports/${body.id}/status`).set(auth(adminToken)).send({version:1,status:'resolved',note:'Água escoou após a chuva.'})
  ]);
  assert.deepEqual(updates.map(r=>r.status).sort(),[200,409]);
  const {body:detail}=await request(app).get(`/api/reports/${body.id}`).expect(200);
  assert.equal(detail.report.version,2);assert.equal(detail.history.length,2);
});
test('somente autor ou gestão pode alterar a situação',async()=>{
  const ordinary=await request(app).post('/api/auth/register').send({name:'Sem permissão',email:`citizen-${randomUUID()}@teste.local`,password:'Teste@12345'}).expect(201);
  const body=input();await request(app).post('/api/reports').set(auth(token)).send(body).expect(201);
  await request(app).patch(`/api/reports/${body.id}/status`).set(auth(ordinary.body.token)).send({version:1,status:'resolved',note:'Tentativa sem permissão.'}).expect(403);
  await request(app).patch(`/api/reports/${body.id}/status`).set(auth(adminToken)).send({version:1,status:'resolved',note:'Encerrada pela gestão.'}).expect(200);
});
test('filtros e foto preservam dados; coordenadas inválidas são rejeitadas',async()=>{
  await request(app).post('/api/reports').set(auth(token)).send({...input(),latitude:91}).expect(400);
  await request(app).post('/api/reports').set(auth(token)).send({...input(),photo:'data:text/html;base64,PHNjcmlwdD4='}).expect(400);
  const body={...input(),title:'Ponto exclusivo fotografia',photo:'data:image/png;base64,iVBORw0KGgo='};
  await request(app).post('/api/reports').set(auth(token)).send(body).expect(201);
  const list=await request(app).get('/api/reports?q=exclusivo&severity=high&status=active').expect(200);
  assert.equal(list.body.reports.length,1);assert.equal(list.body.reports[0].has_photo,true);assert.equal(list.body.reports[0].photo,undefined);
  await request(app).get(`/api/reports/${body.id}/photo`).expect('Content-Type',/image\/png/).expect(200);
});
test('seed pode ser repetido e mantém dados fictícios identificados',async()=>{
  await seedDemo(db);await seedDemo(db);
  const rows=await db.query('SELECT count(*) AS n FROM reports WHERE is_demo=true');assert.equal(Number(rows.rows[0].n),4);
});
test('logout invalida o token',async()=>{
  await request(app).post('/api/auth/logout').set(auth(token)).expect(204);
  await request(app).get('/api/auth/me').set(auth(token)).expect(401);
});
