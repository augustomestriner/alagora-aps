// Fontes de dados de chuva usadas pelo coletor.
import { readFileSync } from 'node:fs';

const H = 3600_000;
export const horaCheia = (t = Date.now()) => new Date(Math.floor(t / H) * H);

/**
 * Open-Meteo (https://open-meteo.com): API pública e gratuita, sem chave.
 * Uma única requisição traz, para todas as áreas, a chuva das últimas 24 h e a
 * previsão das próximas 6 h, hora a hora. Devolve { [areaId]: [{hora, mm, previsao}] }.
 */
export async function buscarOpenMeteo(areas, { signal, fetchImpl = fetch, agora = Date.now() } = {}) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', areas.map(a => a.latitude).join(','));
  url.searchParams.set('longitude', areas.map(a => a.longitude).join(','));
  url.searchParams.set('hourly', 'precipitation');
  url.searchParams.set('past_hours', '24');
  url.searchParams.set('forecast_hours', '7');
  url.searchParams.set('timezone', 'GMT');
  const resposta = await fetchImpl(url, { signal, headers: { 'User-Agent': 'alagora-aps/2.0 (projeto academico)' } });
  if (!resposta.ok) throw new Error(`Open-Meteo respondeu HTTP ${resposta.status}`);
  let corpo = await resposta.json();
  if (!Array.isArray(corpo)) corpo = [corpo]; // uma coordenada => objeto; várias => lista
  if (corpo.length !== areas.length) throw new Error('Open-Meteo devolveu quantidade inesperada de pontos');
  const ref = horaCheia(agora).getTime();
  const resultado = {};
  areas.forEach((area, i) => {
    const { time, precipitation } = corpo[i]?.hourly || {};
    if (!Array.isArray(time) || !Array.isArray(precipitation)) throw new Error('Resposta do Open-Meteo sem série horária');
    resultado[area.id] = time.map((t, j) => {
      const hora = new Date(`${t}:00Z`);
      return { hora, mm: Math.max(0, Number(precipitation[j]) || 0), previsao: hora.getTime() > ref };
    }).filter(p => !Number.isNaN(p.hora.getTime()));
  });
  return resultado;
}

/**
 * Simulação (replay): 48 h de chuva gravadas em arquivo, com uma tempestade.
 * Para a demonstração o tempo é acelerado: a cada ciclo do coletor a "hora atual"
 * da gravação avança uma posição, e os valores são reposicionados em relação à
 * hora atual real. Assim o risco muda em poucos minutos.
 */
export class Simulacao {
  constructor(arquivo, { inicio } = {}) {
    this.dados = JSON.parse(readFileSync(arquivo, 'utf8'));
    this.horas = this.dados.horas;
    this.posicao = inicio ?? this.dados.inicio ?? 0;
  }

  /** Avança a gravação uma hora e devolve a série no mesmo formato do Open-Meteo. */
  proximo(areas, agora = Date.now()) {
    const ref = horaCheia(agora).getTime();
    const p = this.posicao;
    this.posicao = (this.posicao + 1) % this.horas;
    const resultado = {};
    for (const area of areas) {
      const serie = this.dados.areas[area.id] || [];
      resultado[area.id] = [];
      for (let k = -23; k <= 6; k++) { // 24 h passadas (incluindo a atual) e 6 h à frente
        const i = (((p + k) % this.horas) + this.horas) % this.horas;
        resultado[area.id].push({ hora: new Date(ref + k * H), mm: serie[i] ?? 0, previsao: k > 0 });
      }
    }
    return resultado;
  }
}
