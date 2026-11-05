import {useEffect,useRef} from 'react';
import L from 'leaflet';
import type {RainArea,Report} from './types';
import {riskLabel,severityLabel,statusLabel} from './types';
interface Props {reports:Report[];selected?:string;onSelect?:(id:string)=>void;pick?:[number,number];onPick?:(lat:number,lng:number)=>void;areas?:RainArea[];me?:[number,number];onArea?:(id:string)=>void}
export const riskColors={none:'#8fb17a',attention:'#d9b23c',high:'#d9782f',very_high:'#b8322a'};
const colors={low:'#467e68',moderate:'#c28a24',high:'#c35b43'};
export default function MapView({reports,selected,onSelect,pick,onPick,areas,me,onArea}:Props){
  const root=useRef<HTMLDivElement>(null);const map=useRef<L.Map|null>(null);const layer=useRef<L.LayerGroup|null>(null);const areaLayer=useRef<L.LayerGroup|null>(null);
  const callbacks=useRef({onSelect,onPick,onArea});callbacks.current={onSelect,onPick,onArea};
  useEffect(()=>{
    if(!root.current)return;
    const m=L.map(root.current,{zoomControl:false}).setView([-23.192,-46.89],13);map.current=m;
    L.control.zoom({position:'bottomright'}).addTo(m);
    const tiles=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',maxZoom:19}).addTo(m);
    const warning=new L.Control({position:'topright'});warning.onAdd=()=>{const el=L.DomUtil.create('div','map-warning');el.textContent='Mapa indisponível? Use a lista ou informe as coordenadas.';el.hidden=true;return el;};warning.addTo(m);
    tiles.on('tileerror',()=>{const el=warning.getContainer();if(el)el.hidden=false;});
    areaLayer.current=L.layerGroup().addTo(m);layer.current=L.layerGroup().addTo(m);
    m.on('click',e=>callbacks.current.onPick?.(e.latlng.lat,e.latlng.lng));
    const observer=new ResizeObserver(()=>m.invalidateSize());observer.observe(root.current);
    return()=>{observer.disconnect();m.remove();map.current=null;};
  },[]);
  useEffect(()=>{
    const m=map.current;const group=layer.current;if(!m||!group)return;group.clearLayers();
    for(const r of reports){
      const marker=L.circleMarker([r.latitude,r.longitude],{radius:r.id===selected?13:9,color:'#fff',weight:3,fillColor:r.status==='resolved'?'#7a8d88':colors[r.severity],fillOpacity:.96}).addTo(group);
      // Tooltip como nó de texto, sem interpolação HTML de conteúdo do usuário.
      const tip=document.createElement('div');tip.textContent=`${r.title} · ${severityLabel[r.severity]} · ${statusLabel[r.status]}`;marker.bindTooltip(tip);
      marker.on('click',e=>{L.DomEvent.stopPropagation(e);callbacks.current.onSelect?.(r.id);});
    }
    if(pick)L.circleMarker(pick,{radius:11,color:'#123d35',weight:3,fillColor:'#b5d87b',fillOpacity:1}).addTo(group);
    if(me)L.circleMarker(me,{radius:8,color:'#fff',weight:3,fillColor:'#2a6fdb',fillOpacity:1}).bindTooltip('Sua posição').addTo(group);
  },[reports,selected,pick,me?.[0],me?.[1]]);
  // Áreas de risco de chuva: círculo do tamanho da área, colorido pelo nível de risco.
  useEffect(()=>{
    const group=areaLayer.current;if(!group)return;group.clearLayers();
    for(const a of areas||[]){
      const c=L.circle([a.latitude,a.longitude],{radius:a.radius_m,color:riskColors[a.risk],weight:2,fillColor:riskColors[a.risk],fillOpacity:a.risk==='none'?.08:.22}).addTo(group);
      const tip=document.createElement('div');tip.textContent=`${a.name} · risco ${riskLabel[a.risk].toLowerCase()}`;c.bindTooltip(tip);
      c.on('click',e=>{if(callbacks.current.onArea){L.DomEvent.stopPropagation(e);callbacks.current.onArea(a.id);}});
    }
  },[areas]);
  useEffect(()=>{if(pick)map.current?.panTo(pick);},[pick?.[0],pick?.[1]]);
  useEffect(()=>{const r=reports.find(r=>r.id===selected);if(r)map.current?.panTo([r.latitude,r.longitude]);},[selected]);
  return <div ref={root} className="map-canvas" aria-label={onPick?'Mapa: toque para selecionar o local':'Mapa das ocorrências de alagamento'}/>;
}
