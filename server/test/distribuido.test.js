// Testes das partes distribuídas: tempo real (SSE), sync delta, georreferenciamento,
// coletor com fonte externa simulada, batimentos e comando de simulação.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import request from 'supertest';
import { createDatabase } from '../src/db.js';
import { createApp, ligarEventos } from '../src/app.js';
import { CentralEventos } from '../src/realtime.js';
import { Coletor, garantirAreas } from '../src/coletor.js';
import { fileURLToPath } from 'node:url';

let db, app, central, server, base, token, adminToken, pararEventos;
const auth = t => ({ Authorization: `Bearer ${t}` });
const ocorrencia = (extra = {}) => ({ id: randomUUID(), title: 'Alagamento de teste', description: 'Água acumulada sobre parte da pista.', address: 'Rua de teste, Jundiaí', latitude: -23.2052, longitude: -46.8762, severity: 'high', photo: null, ...extra });
const silencioso = { info() {}, warn() {}, error() {} };

/** Abre uma conexão SSE e devolve um leitor de eventos { tipo, dados }. */
async function abrirSse() {
  const ctrl = new AbortController();
  const resp = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('content-type'), /text\/event-stream/);
  const leitor = resp.body.getReader();
  const decodificador = new TextDecoder();
  let buffer = '';
  const fila = [];
  let leitura = null;
  async function proximo(filtro = () => true, ms = 4000) {
    const limite = Date.now() + ms;
    for (;;) {
      const i = fila.findIndex(filtro);
      if (i >= 0) return fila.splice(i, 1)[0];
      if (Date.now() > limite) throw new Error('evento SSE não chegou a tempo');
      leitura ??= leitor.read(); // uma única leitura pendente por vez, para não perder dados
      const r = await Promise.race([leitura, new Promise(ok => setTimeout(() => ok(null), 200))]);
      if (!r) continue;
      leitura = null;
      const { value, done } = r;
      if (done) throw new Error('conexão SSE encerrada');
      buffer += decodificador.decode(value, { stream: true });
      let fim;
      while ((fim = buffer.indexOf('\n\n')) >= 0) {
        const bloco = buffer.slice(0, fim); buffer = buffer.slice(fim + 2);
        const tipo = bloco.match(/^event: (.+)$/m)?.[1];
        const dados = bloco.match(/^data: (.+)$/m)?.[1];
        if (tipo && dados) fila.push({ tipo, dados: JSON.parse(dados) });
      }
    }
  }
  return { proximo, fechar: () => ctrl.abort() };
}

before(async () => {
  db = await createDatabase({ local: process.env.TEST_POSTGRES !== 'true', log: silencioso });
  await garantirAreas(db);
  central = new CentralEventos({ intervaloPing: 60_000 });
  pararEventos = ligarEventos(db, central);
  app = createApp(db, { logger: false, central, instancia: 'api@teste' });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await request(app).post('/api/auth/register').send({ name: 'Autora teste', email: `a-${randomUUID()}@teste.local`, password: 'Teste@12345' }).expect(201);
  token = r.body.token;
  const s = await request(app).post('/api/auth/register').send({ name: 'Gestão teste', email: `g-${randomUUID()}@teste.local`, password: 'Teste@12345' }).expect(201);
  await db.query("UPDATE users SET role='admin' WHERE id=$1", [s.body.user.id]);
  adminToken = s.body.token;
});
after(async () => { pararEventos?.(); central.fechar(); server.close(); await db.close(); });

test('SSE: aparelho conectado recebe a ocorrência criada e a mudança de situação', async () => {
  const sse = await abrirSse();
  const ola = await sse.proximo(e => e.tipo === 'hello');
  assert.ok(ola.dados.serverTime);
  const body = ocorrencia();
  await request(app).post('/api/reports').set(auth(token)).send(body).expect(201);
  const criado = await sse.proximo(e => e.tipo === 'report' && e.dados.id === body.id);
  assert.equal(criado.dados.version, 1);
  await request(app).patch(`/api/reports/${body.id}/status`).set(auth(token)).send({ version: 1, status: 'monitoring', note: 'Equipe acompanhando.' }).expect(200);
  const alterado = await sse.proximo(e => e.tipo === 'report' && e.dados.id === body.id && e.dados.version === 2);
  assert.equal(alterado.dados.status, 'monitoring');
  sse.fechar();
});

test('SSE: reenvio idempotente e transação desfeita não geram evento', async () => {
  const sse = await abrirSse();
  await sse.proximo(e => e.tipo === 'hello');
  const body = ocorrencia();
  await request(app).post('/api/reports').set(auth(token)).send(body).expect(201);
  await sse.proximo(e => e.tipo === 'report' && e.dados.id === body.id);
  await request(app).post('/api/reports').set(auth(token)).send(body).expect(200); // repetição
  await request(app).patch(`/api/reports/${body.id}/status`).set(auth(token)).send({ version: 9, status: 'resolved', note: 'Versão antiga.' }).expect(409);
  await assert.rejects(sse.proximo(e => e.tipo === 'report' && e.dados.id === body.id, 800), /não chegou/);
  sse.fechar();
});

test('sync delta devolve só o que mudou depois do instante informado', async () => {
  const primeira = await request(app).get('/api/reports').expect(200);
  const marco = primeira.body.serverTime;
  await new Promise(r => setTimeout(r, 20));
  const body = ocorrencia({ title: 'Ponto do delta' });
  await request(app).post('/api/reports').set(auth(token)).send(body).expect(201);
  const delta = await request(app).get(`/api/reports?since=${encodeURIComponent(marco)}`).expect(200);
  assert.equal(delta.body.delta, true);
  assert.deepEqual(delta.body.reports.map(r => r.id), [body.id]);
  await request(app).get('/api/reports?since=ontem').expect(400);
});

test('perto de mim: ocorrências abertas no raio, com distância, e áreas mais próximas', async () => {
  const perto = ocorrencia({ latitude: -23.2060, longitude: -46.8770, title: 'Ponto bem perto' });
  const longe = ocorrencia({ latitude: -23.30, longitude: -46.80, title: 'Ponto longe dali' });
  await request(app).post('/api/reports').set(auth(token)).send(perto).expect(201);
  await request(app).post('/api/reports').set(auth(token)).send(longe).expect(201);
  const r = await request(app).get('/api/nearby?lat=-23.2052&lng=-46.8762&radius=1000').expect(200);
  const ids = r.body.reports.map(x => x.id);
  assert.ok(ids.includes(perto.id));
  assert.ok(!ids.includes(longe.id));
  assert.ok(r.body.reports.every(x => x.distance_m <= 1000));
  assert.equal(r.body.areas[0].id, 'vila-arens');
  await request(app).get('/api/nearby?lat=999&lng=0').expect(400);
});

test('coletor: grava chuva da fonte externa, calcula risco e publica evento', async () => {
  const sse = await abrirSse();
  await sse.proximo(e => e.tipo === 'hello');
  const agora = new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
  const horas = [-2, -1, 0, 1].map(k => new Date(agora.getTime() + k * 3600_000).toISOString().slice(0, 16));
  // Fonte externa falsa: 20 mm na última hora em todas as áreas.
  const fetchImpl = async url => {
    const n = new URL(url).searchParams.get('latitude').split(',').length;
    return { ok: true, json: async () => Array.from({ length: n }, () => ({ hourly: { time: horas, precipitation: [0, 0, 20, 2] } })) };
  };
  const coletor = new Coletor(db, { fonte: 'openmeteo', fetchImpl, log: silencioso, nome: 'coletor@teste' });
  const alteradas = await coletor.ciclo();
  assert.ok(alteradas.length > 0);
  const ev = await sse.proximo(e => e.tipo === 'risk');
  assert.equal(ev.dados.areas.length, 6);
  const { body } = await request(app).get('/api/rain').expect(200);
  const centro = body.areas.find(a => a.id === 'centro');
  assert.equal(centro.rain_1h, 20);
  assert.equal(centro.risk, 'high');
  assert.equal(centro.source, 'open-meteo');
  assert.equal(body.collector.name, 'coletor@teste');
  const hist = await request(app).get('/api/rain/centro/history?horas=24').expect(200);
  assert.ok(hist.body.hours.some(h => h.forecast));
  // Segundo ciclo com os mesmos dados não muda nada (idempotente) e não publica evento.
  assert.deepEqual(await coletor.ciclo(), []);
  sse.fechar();
});

test('coletor: fonte fora do ar abre o disjuntor e usa a simulação identificada', async () => {
  let chamadas = 0;
  const fetchImpl = async () => { chamadas++; throw new Error('rede indisponível'); };
  const coletor = new Coletor(db, { fonte: 'auto', fetchImpl, log: silencioso, nome: 'coletor@teste2', arquivoReplay: fileURLToPath(new URL('../replay/chuva-jundiai.json', import.meta.url)) });
  coletor.disjuntor.limite = 1; // abre logo, para o teste não esperar as novas tentativas
  const espera = coletor.obterSeries;
  const r1 = await espera.call(coletor);
  assert.match(r1.fonte, /simulação/);
  const antes = chamadas;
  const r2 = await espera.call(coletor);
  assert.match(r2.fonte, /simulação/);
  assert.equal(chamadas, antes, 'com o disjuntor aberto a fonte externa não é chamada');
  assert.equal(coletor.disjuntor.estado, 'ABERTO');
});

test('status lista API e coletor com batimento recente', async () => {
  const { body } = await request(app).get('/api/status').expect(200);
  const coletor = body.services.find(s => s.name === 'coletor@teste');
  assert.ok(coletor && coletor.healthy);
  assert.equal(coletor.details.disjuntor.estado, 'FECHADO');
});

test('comando de simulação: só a gestão pode enviar', async () => {
  await request(app).post('/api/admin/simulation').set(auth(token)).send({ active: true }).expect(403);
  await request(app).post('/api/admin/simulation').set(auth(adminToken)).send({ active: true }).expect(202);
  await request(app).post('/api/admin/simulation').send({ active: true }).expect(401);
});
