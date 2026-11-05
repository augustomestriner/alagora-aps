// Testes das regras puras (sem banco): disjuntor, novas tentativas, risco e fontes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Disjuntor, CircuitoAberto, comNovasTentativas, comTempoLimite } from '../src/resiliencia.js';
import { classificar, resumirSerie, distanciaM, AREAS } from '../src/risco.js';
import { buscarOpenMeteo, Simulacao } from '../src/fontes.js';

test('disjuntor abre após 3 falhas, recusa rápido e fecha após teste bem-sucedido', async () => {
  let agora = 0;
  const d = new Disjuntor('x', { limite: 3, pausa: 1000, agora: () => agora });
  const falha = () => Promise.reject(new Error('fora do ar'));
  for (let i = 0; i < 3; i++) await assert.rejects(d.executar(falha), /fora do ar/);
  assert.equal(d.estado, 'ABERTO');
  let chamou = false;
  await assert.rejects(d.executar(async () => { chamou = true; }), CircuitoAberto);
  assert.equal(chamou, false, 'com o circuito aberto a chamada nem é feita');
  agora = 1001;
  assert.equal(await d.executar(async () => 'ok'), 'ok');
  assert.equal(d.estado, 'FECHADO');
});

test('disjuntor meio-aberto reabre na primeira falha', async () => {
  let agora = 0;
  const d = new Disjuntor('x', { limite: 2, pausa: 100, agora: () => agora });
  for (let i = 0; i < 2; i++) await assert.rejects(d.executar(() => Promise.reject(new Error('e'))));
  agora = 200;
  await assert.rejects(d.executar(() => Promise.reject(new Error('e'))));
  assert.equal(d.estado, 'ABERTO');
});

test('novas tentativas com espera crescente até conseguir', async () => {
  const esperas = [];
  let n = 0;
  const r = await comNovasTentativas(async () => { if (++n < 3) throw new Error('instável'); return 'ok'; },
    { tentativas: 3, base: 100, dormir: async ms => { esperas.push(ms); } });
  assert.equal(r, 'ok');
  assert.equal(esperas.length, 2);
  assert.ok(esperas[1] > esperas[0], 'a segunda espera é maior');
});

test('tempo limite cancela operação lenta', async () => {
  await assert.rejects(comTempoLimite(signal => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason))), 30), /tempo limite/);
});

test('resumo da série separa passado e previsão', () => {
  const ref = new Date('2026-11-05T12:00:00Z');
  const serie = [
    { hora: '2026-11-04T13:00:00Z', mm: 1 }, // 23 h antes: entra só em 24 h
    { hora: '2026-11-05T10:00:00Z', mm: 2 },
    { hora: '2026-11-05T11:00:00Z', mm: 3 },
    { hora: '2026-11-05T12:00:00Z', mm: 4 }, // hora atual
    { hora: '2026-11-05T13:00:00Z', mm: 5 }, // previsão
    { hora: '2026-11-05T16:00:00Z', mm: 9 }, // além de 3 h: ignorado
  ];
  assert.deepEqual(resumirSerie(serie, ref), { chuva_1h: 4, chuva_3h: 9, chuva_24h: 10, previsao_3h: 5 });
});

test('classificação usa limiares de chuva e evidência da comunidade', () => {
  const seco = { chuva_1h: 0, chuva_3h: 0, chuva_24h: 0, previsao_3h: 0 };
  assert.equal(classificar(seco).risco, 'none');
  assert.equal(classificar({ ...seco, chuva_1h: 16 }).risco, 'high');
  assert.equal(classificar({ ...seco, chuva_3h: 55 }).risco, 'very_high');
  assert.equal(classificar({ ...seco, previsao_3h: 500 }).risco, 'high', 'previsão sozinha não passa de alto');
  assert.equal(classificar(seco, { abertas: 1, altas: 0 }).risco, 'attention');
  assert.equal(classificar(seco, { abertas: 2, altas: 2 }).risco, 'high');
});

test('Haversine: Centro → Vila Arens fica entre 2 e 3 km', () => {
  const [c, v] = [AREAS[0], AREAS[2]];
  const d = distanciaM(c.latitude, c.longitude, v.latitude, v.longitude);
  assert.ok(d > 2000 && d < 3000, String(d));
});

test('Open-Meteo: interpreta resposta com várias coordenadas', async () => {
  const areas = AREAS.slice(0, 2);
  const corpo = areas.map(() => ({ hourly: { time: ['2026-11-05T11:00', '2026-11-05T12:00', '2026-11-05T13:00'], precipitation: [0.2, 1.5, 3] } }));
  let urlChamada;
  const fetchImpl = async url => { urlChamada = String(url); return { ok: true, json: async () => corpo }; };
  const r = await buscarOpenMeteo(areas, { fetchImpl, agora: Date.parse('2026-11-05T12:30:00Z') });
  assert.match(urlChamada, /latitude=-23\.1857%2C-23\.1951/);
  assert.equal(r.centro.length, 3);
  assert.equal(r.centro[2].previsao, true);
  assert.equal(r.centro[1].previsao, false);
  assert.equal(r.anhangabau[1].mm, 1.5);
});

test('Open-Meteo: erro HTTP vira exceção', async () => {
  await assert.rejects(buscarOpenMeteo(AREAS, { fetchImpl: async () => ({ ok: false, status: 502 }) }), /HTTP 502/);
});

test('simulação avança uma hora por ciclo e chega à tempestade', () => {
  const s = new Simulacao(fileURLToPath(new URL('../replay/chuva-jundiai.json', import.meta.url)));
  const ref = Date.parse('2026-11-05T12:10:00Z');
  const riscos = [];
  for (let i = 0; i < 10; i++) {
    const serie = s.proximo(AREAS, ref)['vila-arens'];
    assert.equal(serie.length, 30);
    riscos.push(classificar(resumirSerie(serie, new Date('2026-11-05T12:00:00Z'))).risco);
  }
  assert.equal(riscos[0], 'none');
  assert.ok(riscos.includes('very_high'), riscos.join(','));
});
