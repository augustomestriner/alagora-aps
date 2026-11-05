export type Severity='low'|'moderate'|'high';
export type Status='active'|'monitoring'|'resolved';
export interface User {id:string;name:string;email:string;role:'citizen'|'admin'}
export interface Report {id:string;author_id:string;author_name:string;title:string;description:string;address:string;latitude:number;longitude:number;severity:Severity;status:Status;version:number;is_demo:boolean;has_photo:boolean;created_at:string;updated_at:string}
export interface ReportInput {id:string;title:string;description:string;address:string;latitude:number;longitude:number;severity:Severity;photo:string|null}
export interface History {from_status:Status|null;to_status:Status;note:string;version:number;created_at:string;user_name:string}
export const severityLabel:Record<Severity,string>={low:'Baixa',moderate:'Moderada',high:'Alta'};
export const statusLabel:Record<Status,string>={active:'Ativa',monitoring:'Em acompanhamento',resolved:'Resolvida'};
export type Risk='none'|'attention'|'high'|'very_high';
export const riskLabel:Record<Risk,string>={none:'Sem risco',attention:'Atenção',high:'Alto',very_high:'Muito alto'};
export const riskOrder:Record<Risk,number>={none:0,attention:1,high:2,very_high:3};
export interface RainArea {id:string;name:string;latitude:number;longitude:number;radius_m:number;rain_1h:number|null;rain_3h:number|null;rain_24h:number|null;forecast_3h:number|null;open_reports:number|null;high_reports:number|null;risk:Risk;previous_risk:Risk|null;reasons:string|null;source:string|null;reference_hour:string|null;updated_at:string|null;distance_m?:number}
export interface RainHour {hour:string;precipitation_mm:number;forecast:boolean;source:string}
export interface ServiceInfo {name:string;kind:'api'|'collector';started_at:string;last_seen:string;interval_s:number;age_s:number;healthy:boolean;details:Record<string,any>}
export interface NearbyReport {id:string;title:string;address:string;latitude:number;longitude:number;severity:Severity;status:Status;distance_m:number;is_demo:boolean;created_at:string}
export type LiveState='conectando'|'ao-vivo'|'reconectando'|'indisponivel';
