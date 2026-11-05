// Regras de risco de alagamento por área: combinam a chuva medida/prevista
// (dados do coletor) com as ocorrências abertas informadas pela comunidade.

/**
 * Áreas monitoradas em Jundiaí. Coordenadas aproximadas do centro de cada bairro;
 * cada área cobre um círculo de `raio_m` metros. Lista definida pelo grupo.
 */
export const AREAS = [
  { id: 'centro', nome: 'Centro', latitude: -23.1857, longitude: -46.8844, raio_m: 1200 },
  { id: 'anhangabau', nome: 'Anhangabaú', latitude: -23.1951, longitude: -46.8895, raio_m: 1200 },
  { id: 'vila-arens', nome: 'Vila Arens', latitude: -23.2052, longitude: -46.8762, raio_m: 1300 },
  { id: 'vila-virginia', nome: 'Vila Virgínia', latitude: -23.1917, longitude: -46.9021, raio_m: 1200 },
  { id: 'vila-rio-branco', nome: 'Vila Rio Branco', latitude: -23.1745, longitude: -46.8735, raio_m: 1400 },
  { id: 'ponte-sao-joao', nome: 'Ponte São João', latitude: -23.1965, longitude: -46.8650, raio_m: 1400 },
];

export const NIVEIS = ['none', 'attention', 'high', 'very_high'];
export const ROTULOS = { none: 'Sem risco', attention: 'Atenção', high: 'Alto', very_high: 'Muito alto' };

/**
 * Limiares de chuva em milímetros (decisão de projeto do grupo, documentada no relatório):
 * [atenção, alto, muito alto]. A previsão das próximas 3 h eleva no máximo até "alto".
 */
export const LIMIARES = {
  chuva_1h: [5, 15, 30],
  chuva_3h: [10, 30, 50],
  chuva_24h: [30, 60, 100],
  previsao_3h: [10, 25, Infinity],
};

const nivelPor = (valor, [a, b, c]) => (valor >= c ? 3 : valor >= b ? 2 : valor >= a ? 1 : 0);
const arred = v => Math.round(v * 10) / 10;

/**
 * Resume a série horária de uma área em relação a `referencia` (hora cheia atual).
 * Cada item: { hora: Date|string, mm: number }. A chuva de uma hora é o acumulado
 * da hora que termina naquele instante (padrão do Open-Meteo).
 */
export function resumirSerie(serie, referencia) {
  const ref = new Date(referencia).getTime();
  const H = 3600_000;
  let chuva_1h = 0, chuva_3h = 0, chuva_24h = 0, previsao_3h = 0;
  for (const { hora, mm } of serie) {
    const t = new Date(hora).getTime();
    const v = Number(mm) || 0;
    if (t <= ref) {
      if (t > ref - H) chuva_1h += v;
      if (t > ref - 3 * H) chuva_3h += v;
      if (t > ref - 24 * H) chuva_24h += v;
    } else if (t <= ref + 3 * H) {
      previsao_3h += v;
    }
  }
  return { chuva_1h: arred(chuva_1h), chuva_3h: arred(chuva_3h), chuva_24h: arred(chuva_24h), previsao_3h: arred(previsao_3h) };
}

/**
 * Classifica o risco. `ocorrencias` = ocorrências em aberto dentro da área:
 * qualquer ocorrência aberta garante pelo menos "atenção"; duas ou mais de
 * gravidade alta garantem pelo menos "alto" (evidência de campo).
 */
export function classificar(metricas, ocorrencias = { abertas: 0, altas: 0 }) {
  let nivel = Math.max(
    nivelPor(metricas.chuva_1h, LIMIARES.chuva_1h),
    nivelPor(metricas.chuva_3h, LIMIARES.chuva_3h),
    nivelPor(metricas.chuva_24h, LIMIARES.chuva_24h),
    nivelPor(metricas.previsao_3h, LIMIARES.previsao_3h),
  );
  const motivos = [];
  if (nivel > 0) motivos.push('chuva');
  if (ocorrencias.abertas > 0 && nivel < 1) { nivel = 1; motivos.push('ocorrências'); }
  if (ocorrencias.altas >= 2 && nivel < 2) { nivel = 2; motivos.push('ocorrências graves'); }
  return { risco: NIVEIS[nivel], motivos };
}

/** Distância em metros entre dois pontos (fórmula de Haversine). */
export function distanciaM(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Expressão SQL equivalente (Haversine), para filtrar por raio no banco. $lat/$lng são parâmetros. */
export const sqlDistancia = (lat, lng, colLat = 'latitude', colLng = 'longitude') =>
  `(6371000*2*asin(sqrt(power(sin(radians((${colLat}-${lat})/2)),2)+cos(radians(${lat}))*cos(radians(${colLat}))*power(sin(radians((${colLng}-${lng})/2)),2))))`;
