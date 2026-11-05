import {openDB} from 'idb';
import type {Report,ReportInput} from './types';
export interface Pending {id:string;userId:string;server:string;body:ReportInput;createdAt:string;error?:string}
const database=openDB('alagora',1,{upgrade(db){db.createObjectStore('cache');db.createObjectStore('pending',{keyPath:'id'});}});
export async function readCache(server:string):Promise<Report[]>{return (await (await database).get('cache',server))||[];}
export async function writeCache(server:string,reports:Report[]){await (await database).put('cache',reports,server);}
export async function pendingFor(userId:string,server:string):Promise<Pending[]>{return (await (await database).getAll('pending')).filter((p:Pending)=>p.userId===userId&&p.server===server);}
export async function savePending(p:Pending){await (await database).put('pending',p);}
export async function removePending(id:string){await (await database).delete('pending',id);}
