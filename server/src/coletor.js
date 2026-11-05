// Serviço coletor: processo separado da API. A cada ciclo busca a chuva por área
// numa fonte externa, grava no banco, recalcula o risco de alagamento e publica
// um evento no canal. A API repassa o evento aos aparelhos em tempo real.
import { hostname } from 'node:os';
import { AREAS, classificar, resumirSerie } from './risco.js';
import { buscarOpenMeteo, horaCheia, Simulacao } from './fontes.js';
import { comNovasTentativas, comTempoLimite, Disjuntor } from './resiliencia.js';

const BLOQUEIO_CICLO = 4162602;

/** Garante as áreas monitoradas no banco (idempotente). */
export async function garantirAreas(db) {
  for (const a of AREAS) {
    await db.query(`INSERT INTO rain_areas(id,name,latitude,longitude,radius_m) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,radius_m=EXCLUDED.radius_m`,
      [a.id, a.nome, a.latitude, a.longitude, a.raio_m]);
  }
}

/** Grava o batimento ("heartbeat") de um serviço. */
export async function registrarBatimento(db, nome, tipo, intervaloS, detalhes) {
  await db.query(`INSERT INTO services(name,kind,interval_s,details,last_seen) VALUES ($1,$2,$3,$4,now())
    ON CONFLICT(name) DO UPDATE SET last_seen=now(),interval_s=EXCLUDED.interval_s,details=EXCLUDED.details`,
    [nome, tipo, intervaloS, JSON.stringify(detalhes)]);
}

export class Coletor {
  /**
   * @param fonte 'auto' (Open-Meteo; se falhar, simulação identificada), 'openmeteo' ou 'replay'.
   */
  constructor(db, { fonte = 'auto', intervaloS = 120, arquivoReplay, fetchImpl = fetch, log = console, nome = `coletor@${hostname()}` } = {}) {
    Object.assign(this, { db, fonte, intervaloS, fetchImpl, log, nome });
    this.disjuntor = new Disjuntor('open-meteo', { limite: 3, pausa: 5 * 60_000 });
    this.simulacao = arquivoReplay ? new Simulacao(arquivoReplay) : null;
    this.simulacaoForcada = fonte === 'replay';
    this.ciclos = 0;
    this.ultimoCiclo = null;
    this.rodando = false;
    this.timers = [];
  }

  detalhes() {
    return {
      fonte_configurada: this.fonte,
      simulacao_ativa: this.simulacaoForcada,
      ultima_fonte: this.ultimoCiclo?.fonte ?? null,
      ultimo_ciclo: this.ultimoCiclo?.em ?? null,
      duracao_ms: this.ultimoCiclo?.duracaoMs ?? null,
      resultado: this.ultimoCiclo?.resultado ?? null,
      erro: this.ultimoCiclo?.erro ?? null,
      ciclos: this.ciclos,
      intervalo_coleta_s: this.intervaloS,
      disjuntor: this.disjuntor.resumo(),
    };
  }

  async batimento() {
    try { await registrarBatimento(this.db, this.nome, 'collector', 15, this.detalhes()); }
    catch (e) { this.log.warn?.(`[coletor] batimento falhou: ${e.message}`); }
  }

  /** Obtém as séries de chuva conforme a fonte; devolve { series, fonte }. */
  async obterSeries() {
    if (this.simulacaoForcada) {
      if (!this.simulacao) throw new Error('Arquivo de simulação não configurado');
      return { series: this.simulacao.proximo(AREAS), fonte: 'simulação' };
    }
    try {
      const series = await this.disjuntor.executar(() =>
        comNovasTentativas(() => comTempoLimite(signal => buscarOpenMeteo(AREAS, { signal, fetchImpl: this.fetchImpl }), 8000), {
          tentativas: 3, base: 1000,
          aoFalhar: (e, n) => this.log.warn?.(`[coletor] Open-Meteo tentativa ${n}/3 falhou: ${e.message}`),
        }));
      return { series, fonte: 'open-meteo' };
    } catch (erro) {
      if (this.fonte === 'auto' && this.simulacao) {
        // Degradação: sem a fonte externa, continua funcionando com dados simulados, identificados como tal.
        this.log.warn?.(`[coletor] ${erro.message}; usando simulação`);
        return { series: this.simulacao.proximo(AREAS), fonte: 'simulação (Open-Meteo indisponível)' };
      }
      throw erro;
    }
  }

  /**
   * Um ciclo completo. Usa um bloqueio consultivo do PostgreSQL para que, se houver
   * mais de um coletor rodando, só um execute o ciclo de cada vez.
   */
  async ciclo({ coletar = true } = {}) {
    const inicio = Date.now();
    const referencia = horaCheia();
    try {
      let series = null, fonte = null;
      if (coletar) ({ series, fonte } = await this.obterSeries());
      const mudaram = await this.db.transaction(async q => {
        if (!this.db.local) {
          const { rows } = await q('SELECT pg_try_advisory_xact_lock($1) AS ok', [BLOQUEIO_CICLO]);
          if (!rows[0].ok) return null; // outro coletor está no meio de um ciclo
        }
        if (series) {
          for (const area of AREAS) {
            for (const p of series[area.id] || []) {
              // Chave natural (área, hora): repetir o ciclo atualiza em vez de duplicar.
              await q(`INSERT INTO rain_hourly(area_id,hour,precipitation_mm,forecast,source) VALUES ($1,$2,$3,$4,$5)
                ON CONFLICT(area_id,hour) DO UPDATE SET precipitation_mm=EXCLUDED.precipitation_mm,forecast=EXCLUDED.forecast,source=EXCLUDED.source,collected_at=now()`,
                [area.id, p.hora, p.mm, p.previsao, fonte]);
            }
          }
          await q("DELETE FROM rain_hourly WHERE hour<now()-interval '3 days'");
        }
        const alteradas = [];
        for (const area of AREAS) {
          const { rows: horas } = await q(`SELECT hour,precipitation_mm,source FROM rain_hourly WHERE area_id=$1 AND hour>$2::timestamptz-interval '24 hours' AND hour<=$2::timestamptz+interval '3 hours' ORDER BY hour`, [area.id, referencia]);
          const metricas = resumirSerie(horas.map(h => ({ hora: h.hour, mm: h.precipitation_mm })), referencia);
          // Evidência da comunidade: ocorrências em aberto dentro do raio da área.
          const { rows: [oc] } = await q(`SELECT count(*)::int AS abertas, count(*) FILTER (WHERE severity='high')::int AS altas FROM reports
            WHERE status<>'resolved' AND (6371000*2*asin(sqrt(power(sin(radians((latitude-$1)/2)),2)+cos(radians($1))*cos(radians(latitude))*power(sin(radians((longitude-$2)/2)),2))))<=$3`,
            [area.latitude, area.longitude, area.raio_m]);
          const { risco, motivos } = classificar(metricas, oc);
          const { rows: [antes] } = await q('SELECT risk,rain_1h,rain_3h,rain_24h,forecast_3h,open_reports,high_reports FROM rain_status WHERE area_id=$1', [area.id]);
          const fonteArea = fonte || horas.at(-1)?.source || 'sem dados';
          await q(`INSERT INTO rain_status(area_id,rain_1h,rain_3h,rain_24h,forecast_3h,open_reports,high_reports,risk,previous_risk,reasons,source,reference_hour,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
            ON CONFLICT(area_id) DO UPDATE SET rain_1h=EXCLUDED.rain_1h,rain_3h=EXCLUDED.rain_3h,rain_24h=EXCLUDED.rain_24h,forecast_3h=EXCLUDED.forecast_3h,
              open_reports=EXCLUDED.open_reports,high_reports=EXCLUDED.high_reports,
              previous_risk=CASE WHEN rain_status.risk<>EXCLUDED.risk THEN rain_status.risk ELSE rain_status.previous_risk END,
              risk=EXCLUDED.risk,reasons=EXCLUDED.reasons,source=EXCLUDED.source,reference_hour=EXCLUDED.reference_hour,updated_at=now()`,
            [area.id, metricas.chuva_1h, metricas.chuva_3h, metricas.chuva_24h, metricas.previsao_3h, oc.abertas, oc.altas, risco, antes?.risk ?? null, motivos.join(', '), fonteArea, referencia]);
          const r1 = v => Math.round(Number(v) * 10) / 10; // REAL no banco: compara com 1 casa decimal
          const igual = antes && antes.risk === risco && r1(antes.rain_1h) === metricas.chuva_1h && r1(antes.rain_3h) === metricas.chuva_3h
            && r1(antes.rain_24h) === metricas.chuva_24h && r1(antes.forecast_3h) === metricas.previsao_3h
            && antes.open_reports === oc.abertas && antes.high_reports === oc.altas;
          if (!igual) alteradas.push(area.id);
        }
        if (alteradas.length) await q.notify({ tipo: 'risk', areas: alteradas });
        return alteradas;
      });
      if (coletar) this.ciclos++;
      this.ultimoCiclo = { em: new Date().toISOString(), duracaoMs: Date.now() - inicio, fonte: fonte ?? this.ultimoCiclo?.fonte ?? null, resultado: mudaram === null ? 'ignorado (outro coletor ativo)' : `ok, ${mudaram.length} área(s) alterada(s)`, erro: null };
      this.log.info?.(`[coletor] ciclo ${coletar ? 'completo' : 'de risco'} em ${Date.now() - inicio} ms; fonte=${fonte ?? '-'}; ${this.ultimoCiclo.resultado}`);
      return mudaram;
    } catch (erro) {
      this.ultimoCiclo = { em: new Date().toISOString(), duracaoMs: Date.now() - inicio, fonte: null, resultado: 'falhou', erro: erro.message };
      this.log.error?.(`[coletor] ciclo falhou: ${erro.message}`);
      return null;
    } finally {
      await this.batimento();
    }
  }

  /** Inicia o laço de coleta, o batimento e a assinatura do canal de eventos. */
  async iniciar() {
    this.rodando = true;
    await garantirAreas(this.db);
    await this.batimento();
    this.timers.push(setInterval(() => this.batimento(), 15_000));
    let recalculo = null;
    this.pararEscuta = this.db.listen(evento => {
      // Ocorrência nova/alterada pela comunidade: recalcula o risco sem esperar o próximo ciclo.
      if (evento.tipo === 'report') {
        clearTimeout(recalculo);
        recalculo = setTimeout(() => this.ciclo({ coletar: false }), 1500);
      }
      // Comando enviado pela gestão (via API) para ligar/desligar a simulação de tempestade.
      if (evento.tipo === 'command' && evento.comando === 'simulacao' && this.simulacao) {
        this.simulacaoForcada = Boolean(evento.ativo) || this.fonte === 'replay';
        this.log.info?.(`[coletor] simulação ${this.simulacaoForcada ? 'ligada' : 'desligada'} por ${evento.por || 'comando'}`);
        this.ciclo();
      }
    });
    const laco = async () => {
      if (!this.rodando) return;
      await this.ciclo();
      if (this.rodando) this.timers.push(setTimeout(laco, (this.simulacaoForcada ? Math.min(this.intervaloS, 30) : this.intervaloS) * 1000));
    };
    laco();
  }

  parar() {
    this.rodando = false;
    this.timers.forEach(t => { clearInterval(t); clearTimeout(t); });
    this.pararEscuta?.();
  }
}
