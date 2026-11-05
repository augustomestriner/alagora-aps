// Cliente de tempo real (Server-Sent Events). Mantém uma conexão aberta com a API
// e reconecta sozinho com espera crescente (1 s, 2 s, 4 s… até 30 s) se ela cair.
import {useEffect,useRef,useState} from 'react';
import {Capacitor} from '@capacitor/core';
import {apiUrl,serverBase} from './api';
import type {LiveState,RainArea,Report} from './types';

export interface Handlers {onReport:(r:Report)=>void;onRisk:(areas:RainArea[],changed:string[])=>void;onResync:()=>void}

export function useTempoReal(handlers:Handlers,conexao:number){
  const [estado,setEstado]=useState<LiveState>('conectando');
  const [ultimoEvento,setUltimoEvento]=useState<string>('');
  const [eventos,setEventos]=useState(0);const [instancia,setInstancia]=useState('');
  const h=useRef(handlers);h.current=handlers;
  useEffect(()=>{
    if(typeof EventSource==='undefined'||(Capacitor.isNativePlatform()&&!serverBase())){setEstado('indisponivel');return;}
    let fonte:EventSource|null=null;let espera=1000;let timer:ReturnType<typeof setTimeout>|undefined;let ativo=true;let primeira=true;
    const registrar=()=>{setUltimoEvento(new Date().toISOString());setEventos(n=>n+1);};
    const abrir=()=>{
      if(!ativo)return;
      fonte=new EventSource(apiUrl('/events'));
      fonte.addEventListener('hello',e=>{espera=1000;setEstado('ao-vivo');registrar();try{setInstancia(JSON.parse((e as MessageEvent).data).instance||'');}catch{}
        // Ao (re)conectar, busca o que mudou enquanto estava desconectado.
        if(!primeira)h.current.onResync();primeira=false;});
      fonte.addEventListener('report',e=>{try{h.current.onReport(JSON.parse((e as MessageEvent).data));registrar();}catch{}});
      fonte.addEventListener('risk',e=>{try{const d=JSON.parse((e as MessageEvent).data);h.current.onRisk(d.areas,d.changed||[]);registrar();}catch{}});
      fonte.addEventListener('resync',()=>{h.current.onResync();registrar();});
      fonte.onerror=()=>{
        if(!ativo)return;
        setEstado('reconectando');
        // CONNECTING: o navegador tenta de novo sozinho. CLOSED: nós reabrimos com backoff.
        if(fonte&&fonte.readyState===EventSource.CLOSED){fonte.close();timer=setTimeout(abrir,espera);espera=Math.min(espera*2,30000);}
      };
    };
    abrir();
    const offline=()=>setEstado('reconectando');
    const online=()=>{fonte?.close();clearTimeout(timer);espera=1000;abrir();};
    window.addEventListener('offline',offline);window.addEventListener('online',online);
    return()=>{ativo=false;fonte?.close();clearTimeout(timer);window.removeEventListener('offline',offline);window.removeEventListener('online',online);};
  },[conexao]);
  return {estado,ultimoEvento,eventos,instancia};
}

/** Junta registros recebidos aos atuais: vence a versão mais nova (consistência eventual). */
export function mesclar(atuais:Report[],novos:Report[]):Report[]{
  if(!novos.length)return atuais;
  const mapa=new Map(atuais.map(r=>[r.id,r]));
  for(const n of novos){const a=mapa.get(n.id);if(!a||n.version>a.version||(n.version===a.version&&new Date(n.updated_at)>=new Date(a.updated_at)))mapa.set(n.id,n);}
  return [...mapa.values()].sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime()).slice(0,500);
}
