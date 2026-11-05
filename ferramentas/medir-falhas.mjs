// Medições de tolerância a falhas do Alagora no ambiente Docker real.
// Roda dentro de um contêiner na rede do Compose (veja medir-falhas.bat) e usa a
// API do Docker pelo socket para parar/iniciar serviços. Sem dependências externas.
//
// Cenários: balanceamento entre réplicas, latência de eventos em tempo real,
// queda de uma réplica da API, coletor parado, banco reiniciado e comando de simulação.
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const APP = process.env.APP_URL || 'http://app';
const SAIDA = process.env.SAIDA || '/saida/docs/RESULTADOS-FALHAS.md';
const PROJETO = process.env.PROJETO || 'alagora';
const esperar = ms => new Promise(r => setTimeout(r, ms));
const agora = () => performance.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const md = [];
const linha = s => md.push(s);

// ---------- Docker (socket) ----------
function docker(metodo, caminho) {
  return new Promise((ok, falha) => {
    const req = http.request({ socketPath: '/var/run/docker.sock', path: caminho, method: metodo }, res => {
      let corpo = '';
      res.on('data', c => (corpo += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return falha(new Error(`Docker ${metodo} ${caminho}: HTTP ${res.statusCode} ${corpo}`));
        try { ok(corpo ? JSON.parse(corpo) : null); } catch { ok(corpo); }
      });
    });
    req.on('error', falha);
    req.end();
  });
}
async function conteineres() {
  const filtro = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${PROJETO}`] }));
  const lista = await docker('GET', `/containers/json?all=1&filters=${filtro}`);
  return lista.map(c => ({ id: c.Id, nome: c.Names[0].replace(/^\//, ''), servico: c.Labels['com.docker.compose.service'], estado: c.State }));
}

// ---------- HTTP para o app (pelo Nginx) ----------
async function chamar(metodo, caminho, { corpo, token, timeout = 8000 } = {}) {
  const t0 = agora();
  try {
    const r = await fetch(APP + caminho, {
      method: metodo,
      headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const texto = await r.text();
    let json = null; try { json = JSON.parse(texto); } catch { /* não-JSON */ }
    return { ok: r.ok, status: r.status, ms: agora() - t0, json, instancia: r.headers.get('x-instancia') };
  } catch (e) {
    return { ok: false, status: 0, ms: agora() - t0, erro: e.name === 'TimeoutError' ? 'tempo esgotado' : e.message };
  }
}

// ---------- Cliente SSE com reconexão (como o app faz) ----------
function clienteSse() {
  const c = { eventos: [], conexoes: [], instancia: null, ativo: true, conectado: false, ouvintes: new Set() };
  const emitir = ev => { c.eventos.push(ev); for (const f of c.ouvintes) f(ev); };
  (async function laco() {
    let espera = 500;
    while (c.ativo) {
      try {
        c.ctrl = new AbortController();
        const r = await fetch(APP + '/api/events', { signal: c.ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const leitor = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await leitor.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let fim;
          while ((fim = buf.indexOf('\n\n')) >= 0) {
            const bloco = buf.slice(0, fim); buf = buf.slice(fim + 2);
            const tipo = bloco.match(/^event: (.+)$/m)?.[1];
            const dados = bloco.match(/^data: (.+)$/m)?.[1];
            if (!tipo || !dados) continue;
            const ev = { tipo, dados: JSON.parse(dados), em: agora() };
            if (tipo === 'hello') { c.instancia = ev.dados.instance; c.conectado = true; c.conexoes.push({ em: ev.em, instancia: c.instancia }); espera = 500; }
            emitir(ev);
          }
        }
      } catch { /* conexão caiu ou foi abortada */ }
      c.conectado = false;
      if (!c.ativo) break;
      await esperar(espera);
      espera = Math.min(espera * 2, 8000);
    }
  })();
  c.aguardar = (filtro, ms = 10000) => new Promise((ok, falha) => {
    const t = setTimeout(() => { c.ouvintes.delete(f); falha(new Error('evento não chegou')); }, ms);
    const f = ev => { if (filtro(ev)) { clearTimeout(t); c.ouvintes.delete(f); ok(ev); } };
    c.ouvintes.add(f);
  });
  c.fechar = () => { c.ativo = false; c.ctrl?.abort(); };
  return c;
}

const estat = v => {
  if (!v.length) return { n: 0 };
  const s = [...v].sort((a, b) => a - b);
  const r = x => Math.round(x);
  return { n: s.length, min: r(s[0]), media: r(s.reduce((a, b) => a + b, 0) / s.length), p95: r(s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]), max: r(s.at(-1)) };
};
const fmt = e => e.n ? `${e.media} ms (mín. ${e.min}, p95 ${e.p95}, máx. ${e.max}; n=${e.n})` : 'sem amostras';
async function ate(cond, { cada = 500, max = 120_000 } = {}) {
  const t0 = agora();
  while (agora() - t0 < max) { if (await cond()) return agora() - t0; await esperar(cada); }
  return null;
}
const seg = ms => ms == null ? 'não ocorreu no tempo limite' : `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
const apisSaudaveis = async () => { const r = await chamar('GET', '/api/status'); return r.ok ? r.json.services.filter(s => s.kind === 'api' && s.healthy).length : 0; };
const coletorSaudavel = async () => { const r = await chamar('GET', '/api/status'); return r.ok ? r.json.services.some(s => s.kind === 'collector' && s.healthy) : null; };

// ---------- Cenários ----------
async function main() {
  linha('# Resultados das medições de falhas');
  linha('');
  linha(`Gerado automaticamente por \`ferramentas/medir-falhas.mjs\` em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}, no ambiente Docker Compose (Nginx, réplicas da API, coletor e PostgreSQL). Tempos medidos pelo cliente de teste, que acessa o sistema pelo Nginx como um aparelho faria.`);
  linha('');

  log('aguardando o sistema…');
  if (await ate(async () => (await chamar('GET', '/api/health')).ok, { max: 90_000 }) == null) throw new Error('O app não respondeu em http://app/api/health');
  const lista = await conteineres();
  const apis = lista.filter(c => c.servico === 'api');
  const db = lista.find(c => c.servico === 'db');
  const coletor = lista.find(c => c.servico === 'coletor');
  log('contêineres:', lista.map(c => `${c.nome}(${c.estado})`).join(', '));
  await ate(async () => (await apisSaudaveis()) >= apis.length, { max: 60_000 });

  const demo = (await chamar('POST', '/api/auth/login', { corpo: { email: 'demo@alagora.local', password: 'Demo@12345' } })).json?.token;
  const admin = (await chamar('POST', '/api/auth/login', { corpo: { email: 'admin@alagora.local', password: 'Admin@12345' } })).json?.token;
  if (!demo || !admin) throw new Error('Contas de demonstração indisponíveis (SEED_DEMO=true?)');

  // 1. Balanceamento
  log('1. balanceamento');
  const contagem = {};
  for (let i = 0; i < 40; i++) { const r = await chamar('GET', '/api/health'); const k = r.json?.instance || 'erro'; contagem[k] = (contagem[k] || 0) + 1; }
  linha('## 1. Balanceamento entre réplicas da API');
  linha('');
  linha(`${apis.length} réplica(s) em execução. 40 requisições \`GET /api/health\` seguidas pelo Nginx:`);
  linha('');
  linha('| Réplica que respondeu | Requisições |');
  linha('| --- | --- |');
  for (const [k, v] of Object.entries(contagem)) linha(`| ${k} | ${v} |`);
  linha('');

  // 2. Latência de eventos em tempo real
  log('2. latência de eventos');
  const sse = clienteSse();
  await ate(async () => sse.conectado, { max: 15_000 });
  const ocorrencia = { id: crypto.randomUUID(), title: 'Medição automática (pode ignorar)', description: 'Registro criado pela ferramenta de medição de falhas.', address: 'Centro, Jundiaí', latitude: -23.1857, longitude: -46.8844, severity: 'low', photo: null };
  let t0 = agora();
  const esperaCriado = sse.aguardar(e => e.tipo === 'report' && e.dados.id === ocorrencia.id);
  const criado = await chamar('POST', '/api/reports', { corpo: ocorrencia, token: demo });
  const evCriado = await esperaCriado.catch(() => null);
  const latCriacao = evCriado ? evCriado.em - t0 : null;
  let versao = criado.json?.report?.version ?? 1;
  const latencias = [];
  let cruzadas = 0;
  for (let i = 0; i < 10; i++) {
    const novo = i % 2 === 0 ? 'monitoring' : 'active';
    const espera = sse.aguardar(e => e.tipo === 'report' && e.dados.id === ocorrencia.id && e.dados.version === versao + 1);
    t0 = agora();
    const r = await chamar('PATCH', `/api/reports/${ocorrencia.id}/status`, { corpo: { version: versao, status: novo, note: 'Medição de latência.' }, token: demo });
    if (!r.ok) { log('patch falhou', r.status, r.json); break; }
    if (r.instancia && sse.instancia && r.instancia !== sse.instancia) cruzadas++;
    const ev = await espera.catch(() => null);
    if (ev) latencias.push(ev.em - t0);
    versao++;
    await esperar(150);
  }
  linha('## 2. Latência do tempo real');
  linha('');
  linha('Tempo entre o início da requisição de escrita e a chegada do evento SSE a outro cliente conectado (inclui gravação, COMMIT, NOTIFY, repasse pela réplica e envio pelo Nginx).');
  linha('');
  linha('| Medida | Resultado |');
  linha('| --- | --- |');
  linha(`| Criação de ocorrência → evento | ${latCriacao == null ? 'não chegou' : Math.round(latCriacao) + ' ms'} |`);
  linha(`| Mudança de situação → evento (10 alterações) | ${fmt(estat(latencias))} |`);
  linha(`| Alterações gravadas por uma réplica e entregues pelo SSE de outra | ${cruzadas} de ${latencias.length} |`);
  linha('');

  // 3. Queda de uma réplica da API
  log('3. queda de réplica');
  linha('## 3. Queda de uma réplica da API');
  linha('');
  if (apis.length < 2) {
    linha('Ignorado: há só uma réplica da API em execução (defina `API_REPLICAS=2`).');
  } else {
    const alvo = apis.find(c => sse.instancia?.endsWith(c.id.slice(0, 12))) || apis[0];
    const conexoesAntes = sse.conexoes.length;
    let total = 0, falhas = 0; const tempos = []; const erros = {};
    let carga = true;
    const cargaP = (async () => { while (carga) { const r = await chamar('GET', '/api/reports', { timeout: 6000 }); total++; if (!r.ok) { falhas++; erros[r.status || r.erro] = (erros[r.status || r.erro] || 0) + 1; } else tempos.push(r.ms); await esperar(200); } })();
    await esperar(3000);
    log('parando', alvo.nome);
    const tParada = agora();
    await docker('POST', `/containers/${alvo.id}/stop?t=2`);
    await ate(async () => sse.conexoes.length > conexoesAntes && sse.conectado, { cada: 100, max: 30_000 });
    const nova = sse.conexoes[conexoesAntes];
    const tReconexao = nova ? nova.em - tParada : null;
    // Quanto tempo a tela de status leva para mostrar a réplica parada como sem sinal.
    const nomeAlvo = `api@${alvo.id.slice(0, 12)}`;
    const tSemSinal = await ate(async () => { const r = await chamar('GET', '/api/status'); return r.ok && r.json.services.some(s => s.name === nomeAlvo && !s.healthy); }, { cada: 1000, max: 90_000 });
    const tSemSinalTotal = tSemSinal == null ? null : agora() - tParada;
    carga = false; await cargaP;
    // Evento ainda chega com uma réplica fora?
    const espera = sse.aguardar(e => e.tipo === 'report' && e.dados.id === ocorrencia.id && e.dados.version === versao + 1);
    const tEv = agora();
    const rp = await chamar('PATCH', `/api/reports/${ocorrencia.id}/status`, { corpo: { version: versao, status: versao % 2 ? 'monitoring' : 'active', note: 'Medição com réplica fora.' }, token: demo });
    const evDep = rp.ok ? await espera.catch(() => null) : null;
    if (rp.ok) versao++;
    await docker('POST', `/containers/${alvo.id}/start`);
    // Volta: contêiner saudável (healthcheck do Docker) e recebendo acessos de novo pelo Nginx.
    const tVolta = await ate(async () => {
      const info = await docker('GET', `/containers/${alvo.id}/json`);
      if (info.State?.Health?.Status !== 'healthy') return false;
      const vistas = new Set();
      for (let i = 0; i < 6; i++) { const r = await chamar('GET', '/api/health'); if (r.json?.instance) vistas.add(r.json.instance); }
      return vistas.has(nomeAlvo);
    }, { cada: 500, max: 120_000 });
    linha(`Réplica parada: \`${alvo.nome}\` (a que atendia o tempo real do cliente de teste). Carga contínua de \`GET /api/reports\` a cada 200 ms durante a queda.`);
    linha('');
    linha('| Medida | Resultado |');
    linha('| --- | --- |');
    linha(`| Requisições durante o teste | ${total} |`);
    linha(`| Requisições com erro | ${falhas}${falhas ? ' (' + Object.entries(erros).map(([k, v]) => `${k}: ${v}`).join(', ') + ')' : ''} |`);
    linha(`| Tempo de resposta durante a queda | ${fmt(estat(tempos))} |`);
    linha(`| Tempo até o tempo real reconectar em outra réplica | ${seg(tReconexao)} após o comando de parada${sse.instancia ? ` (agora em ${sse.instancia})` : ''} |`);
    linha(`| Tempo até a tela de status mostrar a réplica parada como sem sinal | ${seg(tSemSinalTotal)} (batimento a cada 10 s; limite de 2,5 intervalos + 5 s) |`);
    linha(`| Evento entregue com a réplica fora | ${evDep ? Math.round(evDep.em - tEv) + ' ms' : 'não'} |`);
    linha(`| Tempo até a réplica religada ficar saudável e voltar a receber acessos pelo Nginx | ${seg(tVolta)} após o comando de início |`);
  }
  linha('');

  // 4. Coletor parado
  log('4. coletor parado');
  linha('## 4. Serviço coletor parado');
  linha('');
  if (!coletor) linha('Ignorado: coletor não encontrado.');
  else {
    await docker('POST', `/containers/${coletor.id}/stop?t=2`);
    const tSemSinal = await ate(async () => (await coletorSaudavel()) === false, { cada: 2000, max: 120_000 });
    const rain = await chamar('GET', '/api/rain');
    const reports = await chamar('GET', '/api/reports');
    await docker('POST', `/containers/${coletor.id}/start`);
    const tVolta = await ate(async () => (await coletorSaudavel()) === true, { cada: 1000, max: 90_000 });
    linha('| Medida | Resultado |');
    linha('| --- | --- |');
    linha(`| Tempo até o status marcar o coletor como sem sinal | ${seg(tSemSinal)} (batimento a cada 15 s; limite de 2,5 intervalos + 5 s) |`);
    linha(`| API com o coletor parado | \`/api/rain\` HTTP ${rain.status} (último risco calculado), \`/api/reports\` HTTP ${reports.status} |`);
    linha(`| Tempo até o coletor religado voltar a saudável | ${seg(tVolta)} |`);
  }
  linha('');

  // 5. Banco reiniciado
  log('5. banco reiniciado');
  linha('## 5. Banco de dados reiniciado');
  linha('');
  if (!db) linha('Ignorado: banco não encontrado.');
  else {
    const resyncAntes = sse.eventos.filter(e => e.tipo === 'resync').length;
    const tR = agora();
    let primeiroErro = null, ultimoErro = null, erros = 0, total = 0;
    let carga = true;
    const cargaP = (async () => { while (carga) { const r = await chamar('GET', '/api/health', { timeout: 4000 }); total++; if (!r.ok) { erros++; primeiroErro ??= agora() - tR; ultimoErro = agora() - tR; } await esperar(250); } })();
    await docker('POST', `/containers/${db.id}/restart?t=3`);
    await esperar(1500);
    let tSaude = null, tResync = null;
    await ate(async () => { const ok = (await chamar('GET', '/api/health', { timeout: 3000 })).ok; if (ok) tSaude = agora() - tR; return ok; }, { cada: 500, max: 90_000 });
    await ate(async () => { const ok = sse.eventos.filter(e => e.tipo === 'resync').length > resyncAntes; if (ok) tResync = agora() - tR; return ok; }, { cada: 250, max: 60_000 });
    carga = false; await cargaP;
    // O canal voltou? Uma alteração deve gerar evento de novo.
    await ate(async () => sse.conectado, { max: 20_000 });
    const espera = sse.aguardar(e => e.tipo === 'report' && e.dados.id === ocorrencia.id && e.dados.version === versao + 1, 15_000);
    const tEv = agora();
    const rp = await chamar('PATCH', `/api/reports/${ocorrencia.id}/status`, { corpo: { version: versao, status: versao % 2 ? 'monitoring' : 'active', note: 'Medição após reinício do banco.' }, token: demo });
    const evDep = rp.ok ? await espera.catch(() => null) : null;
    if (rp.ok) versao++;
    linha('| Medida | Resultado |');
    linha('| --- | --- |');
    linha(`| Requisições \`/api/health\` com erro durante o reinício | ${erros} de ${total}${erros ? ` (janela de ${seg(ultimoErro - primeiroErro)})` : ''} |`);
    linha(`| Tempo até a API voltar a responder com o banco | ${seg(tSaude)} após o comando de reinício |`);
    linha(`| Assinatura do canal (LISTEN) restabelecida e \`resync\` enviado aos aparelhos | ${tResync == null ? 'não observado' : 'sim, ' + seg(tResync) + ' após o comando de reinício'} |`);
    linha(`| Evento em tempo real após o reinício | ${evDep ? Math.round(evDep.em - tEv) + ' ms' : 'não chegou'} |`);
  }
  linha('');

  // 6. Comando de simulação
  log('6. comando de simulação');
  const esperaRisk = sse.aguardar(e => e.tipo === 'risk', 20_000);
  t0 = agora();
  const cmd = await chamar('POST', '/api/admin/simulation', { corpo: { active: true }, token: admin });
  const evRisk = cmd.ok ? await esperaRisk.catch(() => null) : null;
  await chamar('POST', '/api/admin/simulation', { corpo: { active: false }, token: admin });
  linha('## 6. Comando assíncrono para o coletor');
  linha('');
  linha('| Medida | Resultado |');
  linha('| --- | --- |');
  linha(`| \`POST /api/admin/simulation\` → coletor recebe pelo canal, recalcula e o evento \`risk\` chega ao aparelho | ${evRisk ? Math.round(evRisk.em - t0) + ' ms' : 'não chegou'} (resposta HTTP ${cmd.status}) |`);
  linha('');

  // Limpeza
  await chamar('PATCH', `/api/reports/${ocorrencia.id}/status`, { corpo: { version: versao, status: 'resolved', note: 'Medição encerrada.' }, token: demo });
  await chamar('POST', '/api/auth/logout', { token: demo });
  await chamar('POST', '/api/auth/logout', { token: admin });
  sse.fechar();
  linha('## Observações');
  linha('');
  linha('- Requisições de leitura que encontram uma réplica fora são repetidas pelo Nginx na outra réplica (`proxy_next_upstream`); escritas (POST) não são repetidas pelo proxy, pois o próprio app reenvia com o mesmo identificador (idempotência).');
  linha('- O registro “Medição automática (pode ignorar)” foi criado e encerrado pela ferramenta.');
  writeFileSync(SAIDA, md.join('\n') + '\n');
  log('resultados gravados em', SAIDA);
  console.log('\n' + md.join('\n'));
}

main().then(() => process.exit(0)).catch(e => { console.error('FALHOU:', e.message); try { writeFileSync(SAIDA, md.join('\n') + `\n\n**A medição parou com erro:** ${e.message}\n`); } catch { /* ignore */ } process.exit(1); });
