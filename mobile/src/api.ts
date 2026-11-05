import {Capacitor} from '@capacitor/core';
import type {User} from './types';
export class ApiError extends Error {constructor(public status:number,message:string){super(message);}}
export const serverBase=()=>localStorage.getItem('alagora.server')||'';
export const serverKey=()=>serverBase()||window.location.origin;
export const apiUrl=(path:string)=>`${serverBase()}/api${path}`;
export function getSession():{token:string;user:User}|null{try{return JSON.parse(localStorage.getItem('alagora.session')||'null');}catch{return null;}}
export function setSession(session:{token:string;user:User}|null){if(session)localStorage.setItem('alagora.session',JSON.stringify(session));else localStorage.removeItem('alagora.session');}
export async function api<T=any>(path:string,options:RequestInit={}):Promise<T>{
  if(Capacitor.isNativePlatform()&&!serverBase())throw new ApiError(0,'Configure o endereço do servidor em Conexão.');
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetch(apiUrl(path),{...options,signal:controller.signal,headers:{'Content-Type':'application/json',...(getSession()?{Authorization:`Bearer ${getSession()!.token}`} :{}),...options.headers}});
    if(response.status===204)return undefined as T;
    const body=await response.json();
    if(!response.ok)throw new ApiError(response.status,body.error||'Não foi possível concluir a solicitação.');
    return body;
  }catch(e){if(e instanceof ApiError)throw e;throw new ApiError(0,'Sem conexão com o servidor. Confira a rede e tente novamente.');}
  finally{clearTimeout(timer);}
}
// crypto.randomUUID não está disponível em HTTP por IP; getRandomValues funciona.
export function uuid(){const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
