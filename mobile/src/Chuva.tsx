// Tela "Chuva e risco": chuva por bairro coletada pelo serviço coletor, risco de
// alagamento calculado no servidor e consulta georreferenciada "perto de você".
import {useEffect,useState} from 'react';
import type {CSSProperties} from 'react';
import {CloudRain,LocateFixed,MapPin,Navigation,RefreshCw,Umbrella,X} from 'lucide-react';
import {Geolocation} from '@capacitor/geolocation';
import MapView,{riskColors} from './MapView';
import {api} from './api';
import type {NearbyReport,RainArea,RainHour,Report} from './types';
import {riskLabel,riskOrder,severityLabel} from './types';

const mm=(v:number|null|undefined)=>`${(v??0).toLocaleString('pt-BR',{maximumFractionDigits:1})} mm`;
const dist=(m:number)=>m<1000?`${Math.round(m)} m`:`${(m/1000).toLocaleString('pt-BR',{maximumFractionDigits:1})} km`;
const ago=(d?:string|null)=>{if(!d)return 'nunca';const min=Math.max(0,Math.floor((Date.now()-new Date(d).getTime())/60000));return min<1?'agora':min<60?`há ${min} min`:min<1440?`há ${Math.floor(min/60)} h`:`há ${Math.floor(min/1440)} dias`;};

export function RiskBadge({risk}:{risk:RainArea['risk']}){return <span className={`risk-badge ${risk}`} style={{'--risk':riskColors[risk]} as CSSProperties}><i/>{riskLabel[risk]}</span>;}

interface Props {areas:RainArea[];collector:any;reports:Report[];me?:[number,number];setMe:(p:[number,number]|undefined)=>void;reload:()=>void;loading:boolean}

export default function Chuva({areas,collector,reports,me,setMe,reload,loading}:Props){
  const [aberta,setAberta]=useState<string>();const [escolhendo,setEscolhendo]=useState(false);const [geoBusy,setGeoBusy]=useState(false);const [erro,setErro]=useState('');
  const [perto,setPerto]=useState<{reports:NearbyReport[];areas:RainArea[]}|null>(null);const [pertoErro,setPertoErro]=useState('');
  const ordenadas=[...areas].sort((a,b)=>riskOrder[b.risk]-riskOrder[a.risk]||(b.rain_1h??0)-(a.rain_1h??0)||a.name.localeCompare(b.name));
  const fonte=areas.find(a=>a.source)?.source;const atualizado=areas.map(a=>a.updated_at).filter(Boolean).sort().at(-1);
  // Consulta georreferenciada no servidor; repete quando o risco ou as ocorrências mudam.
  useEffect(()=>{if(!me){setPerto(null);return;}let ativo=true;setPertoErro('');
    api<{reports:NearbyReport[];areas:RainArea[]}>(`/nearby?lat=${me[0]}&lng=${me[1]}&radius=2000`).then(r=>{if(ativo)setPerto(r);}).catch(e=>{if(ativo)setPertoErro((e as Error).message);});
    return()=>{ativo=false;};},[me?.[0],me?.[1],areas,reports.length]);
  async function gps(){setGeoBusy(true);setErro('');try{const p=await Geolocation.getCurrentPosition({enableHighAccuracy:true,timeout:10000});setMe([p.coords.latitude,p.coords.longitude]);}catch{setErro('Não foi possível usar o GPS (em HTTP por IP o navegador bloqueia). Toque em "Escolher no mapa".');setEscolhendo(true);}finally{setGeoBusy(false);}}
  const maisProxima=perto?.areas[0];
  return <div className="rain-page">
    <div className="page-heading"><div><div className="eyebrow"><span/> CHUVA E RISCO DE ALAGAMENTO</div><h1>A chuva, bairro por bairro.</h1><p>Chuva medida e prevista coletada de fonte externa pelo serviço coletor, combinada com as ocorrências abertas da comunidade.</p></div><button className="button secondary" onClick={reload} disabled={loading}><RefreshCw size={17} className={loading?'spin':''}/>Atualizar</button></div>
    <div className="notice source-line"><CloudRain size={18}/><span>{fonte?<>Fonte: <strong>{fonte}</strong> · atualizado {ago(atualizado)}</>:'Aguardando a primeira coleta do serviço coletor.'}{collector&&<> · coletor {collector.healthy?<b className="ok">no ar</b>:<b className="bad">sem sinal {ago(collector.last_seen)}</b>}</>}</span></div>
    {fonte?.startsWith('simulação')&&<div className="demo-line"><span>SIMULAÇÃO</span>Os valores de chuva vêm de uma gravação de demonstração com uma tempestade, não de medições reais.</div>}

    <section className="near-card">
      <div className="section-title"><div><h2><Navigation size={19}/>Perto de você</h2><p>Ocorrências abertas num raio de 2 km e o risco da área mais próxima.</p></div>
        <div className="near-actions"><button className="text-button" onClick={gps} disabled={geoBusy}><LocateFixed size={15}/>{geoBusy?'Localizando…':'Usar meu GPS'}</button><button className="text-button" onClick={()=>setEscolhendo(true)}><MapPin size={15}/>Escolher no mapa</button>{me&&<button className="icon-button" aria-label="Esquecer minha posição" onClick={()=>setMe(undefined)}><X size={16}/></button>}</div></div>
      {erro&&<div className="form-error" role="alert">{erro}</div>}
      {!me?<p className="muted">Defina sua posição para ver o risco por perto e receber um aviso se ele aumentar enquanto o app estiver aberto.</p>:
        pertoErro?<p className="muted">Consulta indisponível: {pertoErro}</p>:!perto?<p className="muted">Consultando…</p>:<div className="near-body">
          {maisProxima&&<div className="near-risk" style={{borderColor:riskColors[maisProxima.risk]}}><RiskBadge risk={maisProxima.risk}/><strong>{maisProxima.name}</strong><span>{dist(maisProxima.distance_m??0)} do centro da área · chuva na última hora {mm(maisProxima.rain_1h)} · previsão 3 h {mm(maisProxima.forecast_3h)}</span></div>}
          {perto.reports.length===0?<p className="muted">Nenhuma ocorrência aberta num raio de 2 km.</p>:<ul className="near-list">{perto.reports.map(r=><li key={r.id}><span className={`dot ${r.severity}`}/><div><strong>{r.title}</strong><small>{r.address} · {severityLabel[r.severity]} gravidade{r.is_demo?' · DEMO':''}</small></div><b>{dist(r.distance_m)}</b></li>)}</ul>}
        </div>}
    </section>

    <div className="rain-layout">
      <div className="map-panel rain-map">{escolhendo&&<div className="pick-hint">Toque no mapa para marcar sua posição <button onClick={()=>setEscolhendo(false)}>Cancelar</button></div>}
        <MapView reports={reports.filter(r=>r.status!=='resolved')} areas={areas} me={me} onArea={escolhendo?undefined:id=>setAberta(id)} onPick={escolhendo?(lat,lng)=>{setMe([Number(lat.toFixed(6)),Number(lng.toFixed(6))]);setEscolhendo(false);}:undefined}/>
        <div className="map-caption"><span className="map-label"><Umbrella size={15}/>Risco por área</span><div className="map-legend">{(['none','attention','high','very_high'] as const).map(r=><span key={r}><i className="dot" style={{background:riskColors[r]}}/>{riskLabel[r]}</span>)}</div></div></div>
      <div className="area-list">{ordenadas.length===0?<div className="empty"><CloudRain size={30}/><h3>Sem dados de chuva ainda</h3><p>O coletor grava a primeira leitura alguns segundos depois de iniciar.</p></div>:
        ordenadas.map(a=><article key={a.id} className={`area-card ${aberta===a.id?'open':''}`} style={{'--risk':riskColors[a.risk]} as CSSProperties}>
          <button className="area-head" onClick={()=>setAberta(aberta===a.id?undefined:a.id)} aria-expanded={aberta===a.id}>
            <div><h3>{a.name}</h3><small>{a.previous_risk&&a.previous_risk!==a.risk?`antes: ${riskLabel[a.previous_risk].toLowerCase()} · `:''}{ago(a.updated_at)}</small></div><RiskBadge risk={a.risk}/></button>
          <dl className="rain-metrics"><div><dt>Última hora</dt><dd>{mm(a.rain_1h)}</dd></div><div><dt>3 horas</dt><dd>{mm(a.rain_3h)}</dd></div><div><dt>24 horas</dt><dd>{mm(a.rain_24h)}</dd></div><div><dt>Previsão 3 h</dt><dd>{mm(a.forecast_3h)}</dd></div></dl>
          <p className="area-foot">{(a.open_reports??0)>0?`${a.open_reports} ocorrência(s) aberta(s) na área${(a.high_reports??0)>0?`, ${a.high_reports} de alta gravidade`:''}`:'Nenhuma ocorrência aberta na área'}{a.reasons?` · motivo: ${a.reasons}`:''}</p>
          {aberta===a.id&&<Historico id={a.id} atualizado={a.updated_at}/>}
        </article>)}</div>
    </div>
    <div className="safety-note"><Umbrella size={18}/><p>Os níveis de risco seguem limiares definidos pelo grupo para fins acadêmicos (chuva de 1 h, 3 h, 24 h e previsão de 3 h, mais ocorrências da comunidade). Não substituem os alertas da Defesa Civil.</p></div>
  </div>;
}

/** Gráfico de barras da chuva hora a hora (medida e prevista). */
function Historico({id,atualizado}:{id:string;atualizado:string|null}){
  const [horas,setHoras]=useState<RainHour[]|null>(null);const [erro,setErro]=useState('');
  useEffect(()=>{let ativo=true;api<{hours:RainHour[]}>(`/rain/${id}/history?horas=24`).then(r=>{if(ativo)setHoras(r.hours);}).catch(e=>{if(ativo)setErro((e as Error).message);});return()=>{ativo=false;};},[id,atualizado]);
  if(erro)return <p className="muted">Histórico indisponível: {erro}</p>;
  if(!horas)return <p className="muted">Carregando histórico…</p>;
  if(!horas.length)return <p className="muted">Sem leituras nas últimas 24 horas.</p>;
  const max=Math.max(5,...horas.map(h=>h.precipitation_mm));const W=Math.max(1,horas.length);
  return <figure className="rain-chart"><svg viewBox={`0 0 ${W*10} 70`} preserveAspectRatio="none" role="img" aria-label="Chuva por hora nas últimas 24 horas e previsão">
    {horas.map((h,i)=>{const alt=Math.max(h.precipitation_mm>0?2:0,h.precipitation_mm/max*64);return <rect key={h.hour} x={i*10+1} y={68-alt} width={8} height={alt} rx={1.5} className={h.forecast?'forecast':'measured'}><title>{`${new Date(h.hour).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}: ${mm(h.precipitation_mm)}${h.forecast?' (previsão)':''}`}</title></rect>;})}
    <line x1="0" y1="68.5" x2={W*10} y2="68.5" className="axis"/></svg>
    <figcaption><span><i className="measured"/>Medida</span><span><i className="forecast"/>Prevista</span><span>máx. {mm(Math.max(...horas.map(h=>h.precipitation_mm)))}/h</span></figcaption></figure>;
}
