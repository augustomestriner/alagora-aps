// Tela "Status do sistema": mostra os nós do sistema distribuído (instâncias da API
// e coletor) pelos batimentos gravados no banco, e a situação deste aparelho.
import {useCallback,useEffect,useState} from 'react';
import {Activity,CloudOff,CloudRain,Play,Radio,RefreshCw,Server,Square} from 'lucide-react';
import {api,apiUrl,ApiError} from './api';
import type {LiveState,ServiceInfo,User} from './types';

const ago=(s?:number|null)=>s==null?'?':s<60?`há ${Math.round(s)} s`:s<3600?`há ${Math.floor(s/60)} min`:`há ${Math.floor(s/3600)} h`;
const quando=(d?:string|null)=>d?new Date(d).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const LIVE:Record<LiveState,string>={conectando:'conectando…','ao-vivo':'conectado (recebendo eventos)',reconectando:'reconectando…',indisponivel:'indisponível'};
const DISJ:Record<string,string>={FECHADO:'fechado (normal)',ABERTO:'aberto (fonte com falha; chamadas suspensas)',MEIO_ABERTO:'meio-aberto (testando a fonte)'};

interface Props {user?:User;live:LiveState;instancia:string;ultimoEvento:string;eventos:number;online:boolean|null;lastSync:string;pendentes:number;notify:(m:string)=>void}

export default function Status({user,live,instancia,ultimoEvento,eventos,online,lastSync,pendentes,notify}:Props){
  const [dados,setDados]=useState<{services:ServiceInfo[];instance:string;sseClients:number}|null>(null);const [erro,setErro]=useState('');const [busy,setBusy]=useState(false);
  const carregar=useCallback(async()=>{try{setDados(await api('/status'));setErro('');}catch(e){setErro((e as Error).message);}},[]);
  useEffect(()=>{carregar();const t=setInterval(carregar,5000);return()=>clearInterval(t);},[carregar]);
  const coletor=dados?.services.find(s=>s.kind==='collector');
  async function simular(active:boolean){setBusy(true);try{await api('/admin/simulation',{method:'POST',body:JSON.stringify({active})});notify(active?'Simulação de tempestade ligada. O coletor avança uma hora da gravação a cada 30 s.':'Simulação desligada. O coletor volta à fonte configurada.');setTimeout(carregar,1500);}catch(e){notify((e as ApiError).message);}finally{setBusy(false);}}
  return <div className="status-page">
    <div className="page-heading"><div><div className="eyebrow"><span/> OBSERVABILIDADE</div><h1>Status do sistema.</h1><p>Cada serviço grava um batimento periódico no banco. Sem batimento recente, o serviço aparece como sem sinal.</p></div><button className="button secondary" onClick={carregar}><RefreshCw size={17}/>Atualizar</button></div>
    <div className="status-grid">
      <section className="status-card"><h2><Radio size={19}/>Este aparelho</h2><dl className="kv">
        <div><dt>Servidor</dt><dd>{apiUrl('')}</dd></div>
        <div><dt>API</dt><dd className={online===false?'bad':'ok'}>{online===null?'verificando…':online?'acessível':'inacessível'}</dd></div>
        <div><dt>Tempo real (SSE)</dt><dd className={live==='ao-vivo'?'ok':'warn'}>{LIVE[live]}</dd></div>
        {live==='ao-vivo'&&instancia&&<div><dt>Conectado à réplica</dt><dd>{instancia}</dd></div>}
        <div><dt>Eventos recebidos</dt><dd>{eventos} · último às {quando(ultimoEvento)}</dd></div>
        <div><dt>Última sincronização</dt><dd>{quando(lastSync)}</dd></div>
        <div><dt>Registros na fila do aparelho</dt><dd className={pendentes?'warn':''}>{pendentes}</dd></div>
      </dl></section>
      <section className="status-card"><h2><Server size={19}/>Serviços</h2>
        {erro?<div className="notice offline-notice"><CloudOff size={18}/><span>Não foi possível consultar: {erro}</span></div>:!dados?<p className="muted">Consultando…</p>:
        <ul className="service-list">{dados.services.map(s=><li key={s.name}><i className={s.healthy?'ok':'bad'} aria-label={s.healthy?'saudável':'sem sinal'}/><div><strong>{s.kind==='api'?'API':'Coletor'} <small>{s.name}{s.name===dados.instance?' · respondeu agora':''}{s.name===instancia?' · seu tempo real':''}</small></strong>
          <span>Batimento {ago(s.age_s)}{s.healthy?'':' — sem sinal recente'}</span>
          {s.kind==='api'&&<span>{s.details.clientes_tempo_real??0} aparelho(s) em tempo real · {s.details.eventos_enviados??0} evento(s) enviados</span>}
          {s.kind==='collector'&&<><span>Fonte: {s.details.ultima_fonte||'—'}{s.details.simulacao_ativa?' · simulação ligada':''} · ciclos: {s.details.ciclos}</span>
            <span>Último ciclo: {quando(s.details.ultimo_ciclo)} · {s.details.duracao_ms??'—'} ms · {s.details.resultado||'—'}</span>
            {s.details.erro&&<span className="bad">Erro: {s.details.erro}</span>}
            <span>Disjuntor da fonte externa: {DISJ[s.details.disjuntor?.estado]||s.details.disjuntor?.estado} · falhas seguidas: {s.details.disjuntor?.falhas_seguidas??0}</span></>}
        </div></li>)}{dados.services.length===0&&<li className="muted">Nenhum serviço registrou batimento na última hora.</li>}</ul>}
      </section>
    </div>
    {user?.role==='admin'&&<section className="status-card admin-sim"><h2><CloudRain size={19}/>Demonstração (gestão)</h2><p>Envia um comando ao coletor, pelo canal de eventos do banco, para usar a gravação simulada de uma tempestade. O risco por bairro muda a cada ciclo e os aparelhos recebem as mudanças em tempo real.</p>
      <div className="form-actions"><button className="button primary" disabled={busy||!coletor} onClick={()=>simular(true)}><Play size={16}/>Simular tempestade</button><button className="button secondary" disabled={busy||!coletor} onClick={()=>simular(false)}><Square size={15}/>Voltar aos dados reais</button></div>
      {!coletor&&<p className="muted">O coletor não está em execução.</p>}</section>}
    <div className="safety-note"><Activity size={18}/><p>A API roda em {dados?dados.services.filter(s=>s.kind==='api'&&s.healthy).length:'?'} réplica(s); cada atualização desta tela pode ser atendida por uma diferente. Para demonstrar falhas: <code>docker stop alagora-api-1</code> (a outra réplica continua atendendo e o tempo real reconecta), <code>docker compose stop coletor</code> (o batimento envelhece e o app segue funcionando); depois <code>docker start …</code> / <code>docker compose start …</code>. Medições automáticas: <code>medir-falhas.bat</code>.</p></div>
  </div>;
}
