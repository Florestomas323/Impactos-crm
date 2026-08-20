import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Ico, Msg, sinEmoji } from "./iconos";
import * as LU from "lucide-react";

// ═══════════════════════════════════════════════════════════════
//  IMPACT OS — DARK PREMIUM PALETTE
//  Sistema visual centralizado: cambiar aquí re-estiliza toda la app.
//  Se mantienen las mismas claves (RP.*) para no tocar miles de usos.
// ═══════════════════════════════════════════════════════════════
const RP = {
  navy:    "#1D232C",   // superficie elevada (antes header morado)
  navyDark:"#0B0E12",   // banda/fondo más oscuro
  blue:    "#232B36",   // acento medio gris azulado
  accent:  "#C7CCD1",   // acento metálico frío
  ink:     "#F4F4F1",   // texto principal claro
  silver:  "rgba(255,255,255,0.10)", // panel plateado translúcido
  silver2: "rgba(255,255,255,0.12)", // borde plateado fino
  pageBg:  "#0B0E12",   // fondo de la app
  btn:     "#F2F1ED",   // botón principal crema
  btnText: "#111318",   // texto del botón crema
};
const SERIF = "'Archivo','Inter',system-ui,sans-serif";
const SANS  = "'Inter',system-ui,sans-serif";

// ─── FIREBASE CONFIG ──────────────────────────────────────────
// Proyecto: actividad-royal-prestige (tu Firebase existente)
// Colección exclusiva — no toca tu app de actividad anterior
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAbUP9Atr0yVJ14vrpZwoDBxyZyT5B0pRw",
  authDomain:        "actividad-royal-prestige.firebaseapp.com",
  projectId:         "actividad-royal-prestige",
  storageBucket:     "actividad-royal-prestige.firebasestorage.app",
  messagingSenderId: "281689379769",
  appId:             "1:281689379769:web:f72a8b0f8e03b6b69d5c68",
};
const FIRESTORE_DOC = "crm_telemarketing/state"; // documento LEGADO — queda intacto como respaldo, solo se lee para migrar
const FIRESTORE_COL = "crm_telemarketing";

// ── PARTICIÓN POR SECCIONES (límite de Firestore: 1 MB por documento) ──
// Cada sección grande vive en su propio documento → cada una tiene su propio 1 MB.
// Todo lo demás (callLog, config, incentivos, etc.) va junto en "sec_misc".
const SECCIONES_DOC = ["agregados","referidos","prospectos","distribucion","appts","cobranza","reclutamiento"];
const DOC_MISC = "sec_misc";

// ── FRAGMENTACIÓN 5x: las bases de datos pesadas se reparten en 5 documentos ──
// cada una (5 MB de capacidad por base). appts y reclutamiento siguen en 1 doc.
const SECCIONES_5 = ["agregados","referidos","prospectos","distribucion","cobranza","docsSocios","appts"];
const SECCIONES_1 = ["reclutamiento"];
const N_FRAG = 5;

// Divide un arreglo en N_FRAG tramos contiguos.
function fragArray(arr){
  const a = Array.isArray(arr) ? arr : [];
  const tam = Math.ceil(a.length / N_FRAG) || 0;
  const out = [];
  for(let i=0;i<N_FRAG;i++) out.push(tam ? a.slice(i*tam, (i+1)*tam) : []);
  return out;
}
// Divide las entradas de un objeto (claves ordenadas) en N_FRAG tramos.
function fragObjeto(obj){
  const claves = Object.keys(obj||{}).sort();
  const tam = Math.ceil(claves.length / N_FRAG) || 0;
  const out = [];
  for(let i=0;i<N_FRAG;i++){
    const o = {};
    (tam ? claves.slice(i*tam,(i+1)*tam) : []).forEach(k=>{ o[k]=obj[k]; });
    out.push(o);
  }
  return out;
}

// Reparte el estado completo en documentos fragmentados. GENÉRICO sobre las
// claves: ninguna clave del estado puede perderse.
// ── Caché local en IndexedDB: guarda el estado COMPLETO sin el límite de 5 MB
// de localStorage (que se llenó en silencio y dejaba el caché congelado). ──
const idbCache = {
  _db: null,
  _abrir(){
    return new Promise(res => {
      try {
        const rq = indexedDB.open("crm_cache", 1);
        rq.onupgradeneeded = () => { try { rq.result.createObjectStore("kv"); } catch {} };
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
      } catch { res(null); }
    });
  },
  async get(k){
    try {
      const d = this._db || (this._db = await this._abrir());
      if(!d) return null;
      return await new Promise(res => {
        try {
          const rq = d.transaction("kv","readonly").objectStore("kv").get(k);
          rq.onsuccess = () => res(rq.result ?? null);
          rq.onerror = () => res(null);
        } catch { res(null); }
      });
    } catch { return null; }
  },
  async set(k, v){
    try {
      const d = this._db || (this._db = await this._abrir());
      if(!d) return;
      d.transaction("kv","readwrite").objectStore("kv").put(v, k);
    } catch {}
  }
};
function partirEstado(estado){
  const docs = {};
  const misc = {};
  Object.keys(estado || {}).forEach(k => {
    if(k === "cobranza"){
      // cobranza: los clientes (clientesData) se fragmentan; el resto (cfg,
      // meses, reportesFin, recurrentes…) viaja en el fragmento _1.
      const cb = estado.cobranza || {};
      const resto = {};
      Object.keys(cb).forEach(kk => { if(kk !== "clientesData") resto[kk] = cb[kk]; });
      const tieneCD = Object.prototype.hasOwnProperty.call(cb, "clientesData");
      const frags = fragObjeto(cb.clientesData || {});
      for(let i=0;i<N_FRAG;i++){
        const base = i===0 ? { ...resto } : {};
        if(tieneCD) base.clientesData = frags[i];
        docs["sec_cobranza_"+(i+1)] = base;
      }
    } else if(SECCIONES_5.includes(k)){
      const frags = Array.isArray(estado[k]) ? fragArray(estado[k]) : fragObjeto(estado[k]);
      for(let i=0;i<N_FRAG;i++) docs["sec_"+k+"_"+(i+1)] = frags[i];
    } else if(SECCIONES_1.includes(k)){
      docs["sec_" + k] = estado[k];
    } else {
      misc[k] = estado[k];
    }
  });
  docs[DOC_MISC] = misc;
  return docs;
}
// Une los documentos fragmentados de vuelta en un solo estado.
function unirDocs(mapa){
  const estado = { ...(mapa[DOC_MISC] || {}) };
  SECCIONES_1.forEach(s => { if(mapa["sec_" + s] !== undefined) estado[s] = mapa["sec_" + s]; });
  SECCIONES_5.forEach(s => {
    const frags = [];
    for(let i=1;i<=N_FRAG;i++) if(mapa["sec_"+s+"_"+i] !== undefined) frags.push(mapa["sec_"+s+"_"+i]);
    if(!frags.length) return;
    if(s === "cobranza"){
      const cb = {}; const clientes = {}; let tuvoCD = false;
      frags.forEach((f,ix) => {
        Object.keys(f||{}).forEach(kk => {
          if(kk === "clientesData"){ tuvoCD = true; Object.assign(clientes, f[kk] || {}); }
          else if(ix === 0) cb[kk] = f[kk];
        });
      });
      if(tuvoCD) cb.clientesData = clientes;
      estado.cobranza = cb;
    } else if(frags.every(f => Array.isArray(f))){
      estado[s] = [].concat(...frags);
    } else {
      estado[s] = Object.assign({}, ...frags);
    }
  });
  return estado;
}

// ══ DÍA LOCAL (Texas), no UTC ════════════════════════════════════════════════
// ANTES: "hoy" se calculaba con toISOString() = día UTC. Entre las ~6pm y
// medianoche de Texas, UTC ya va en "mañana": una llamada de las 7:30pm caía
// en el contador del día siguiente. Estos helpers usan la hora del teléfono.
function fmtDiaLocal(d){
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function hoyLocal(){ return fmtDiaLocal(new Date()); }
// Convierte un timestamp ISO (guardado en UTC) al DÍA local que le corresponde.
// Fechas sin hora ("2026-07-14") pasan tal cual.
function diaLocal(iso){
  const s = String(iso||"");
  if(!s) return "";
  if(!s.includes("T")) return s.slice(0,10);
  const d = new Date(s);
  return isNaN(d) ? s.slice(0,10) : fmtDiaLocal(d);
}

// ── callLog cooperativo: {fecha:{agente:n}} con compatibilidad legada (números) ──
// Cada agente incrementa SOLO su propia clave desde su dispositivo, y al recibir
// de Firebase se fusiona tomando el MÁXIMO por (fecha, agente): una escritura
// vieja de otro dispositivo ya no puede borrar las llamadas de nadie.
function clObj(v){ return (v && typeof v === "object" && !Array.isArray(v)) ? v : (v ? { Equipo: +v || 0 } : {}); }
function sumDia(v){ const o = clObj(v); return Object.values(o).reduce((a,b)=>a+(+b||0),0); }

// ══ CONTEO ÚNICO DE LLAMADAS — una sola fuente de verdad ═════════════════════
// ANTES: el panel principal leía SOLO callLog (que únicamente subía al tocar el
// botón 📞 y elegir app), mientras que la pestaña Llamadas contaba el historial
// de los clientes (registrar resultado / cambiar estado). Resultado: el panel
// mostraba 0 aunque la telemarketing tuviera 32 llamadas registradas.
// AHORA: ambos usan el MISMO conteo. Se recorre el historial exactamente igual
// que la pestaña Llamadas (tipo "llamada" o "estado") y se fusiona con el
// callLog viejo tomando el MÁXIMO por día/agente, para no perder los días
// históricos que solo quedaron registrados con el botón 📞.
function esContacto(h){ return !!h && (h.tipo === "llamada" || h.tipo === "estado"); }
function contactosPorDia(data){
  const mapa = {};  // { "2026-07-13": { "Chiqui": 12, "Tomas": 3 } }
  const push = (h) => {
    if(!esContacto(h)) return;
    const dia = diaLocal(h.fecha);   // día LOCAL del contacto, no UTC
    if(!dia) return;
    const ag = h.agente || "Equipo";
    if(!mapa[dia]) mapa[dia] = {};
    mapa[dia][ag] = (mapa[dia][ag] || 0) + 1;
  };
  ["agregados","prospectos","distribucion"].forEach(sec =>
    ((data && data[sec]) || []).forEach(c => (c.historial || []).forEach(push)));
  ((data && data.referidos) || []).forEach(anf =>
    (anf.referidos || []).forEach(r => (r.historial || []).forEach(push)));
  return mapa;
}
// El HISTORIAL manda: si un día tiene aunque sea una entrada en el historial,
// ese día se cuenta SOLO con el historial → el panel da EXACTAMENTE el mismo
// número que la pestaña Llamadas, siempre. El callLog viejo se usa únicamente
// como respaldo en días antiguos que no dejaron ninguna entrada de historial
// (así las gráficas históricas no se van a cero).
function conteoLlamadas(data, callLog){
  const hist = contactosPorDia(data);
  const out = {};
  const dias = new Set([...Object.keys(hist), ...Object.keys(callLog || {})]);
  dias.forEach(d => {
    const h = hist[d];
    out[d] = (h && Object.keys(h).length) ? h : clObj((callLog || {})[d]);
  });
  return out;
}
// ── FUSIÓN PROTECTORA DE BASES: al recibir una base desde Firebase, se UNE
// con la local por cliente: el historial y las notas NUNCA se pierden aunque
// otro dispositivo (con estado viejo) escriba encima. eliminado se propaga
// con OR y ultimo_llamado toma el más reciente. Escalares: manda lo remoto.
function claveHist(h){ return h && (h.id || ((h.fecha||"") + "|" + (h.notas||"") + "|" + (h.tipo||""))); }
function unirHistorial(a, b){
  const vistos = new Set(); const out = [];
  [...(a||[]), ...(b||[])].forEach(h=>{
    const k = claveHist(h); if(!h || !k || vistos.has(k)) return;
    vistos.add(k); out.push(h);
  });
  out.sort((x,y)=>String(x.fecha||"").localeCompare(String(y.fecha||"")));
  return out;
}
function mergeClienteBase(loc, rem){
  if(!loc) return rem; if(!rem) return loc;
  const m = { ...loc, ...rem }; // escalares: manda lo remoto (última edición)
  m.historial = unirHistorial(loc.historial, rem.historial);
  // "notas" tiene DOS formatos según la antigüedad del cliente: texto plano o
  // arreglo [{texto,fecha,agente}]. Se fusionan respetando el formato — jamás
  // se convierte un arreglo en texto (eso creaba notas fantasma letra por letra).
  const lN = loc.notas, rN = rem.notas;
  if(Array.isArray(lN) || Array.isArray(rN)){
    const arrL = Array.isArray(lN) ? lN : [];
    const arrR = Array.isArray(rN) ? rN : [];
    const vistosN = new Set(); const unidas = [];
    [...arrR, ...arrL].forEach(x=>{
      if(!x || typeof x !== "object" || !(x.texto||"").trim()) return;
      const k = (x.fecha||"") + "|" + x.texto;
      if(vistosN.has(k)) return; vistosN.add(k); unidas.push(x);
    });
    unidas.sort((a,b)=>String(a.fecha||"").localeCompare(String(b.fecha||"")));
    m.notas = unidas;
  } else if((lN||"") && (rN||"") && lN !== rN){
    m.notas = String(rN).includes(String(lN)) ? rN : String(lN).includes(String(rN)) ? lN : (rN + "\n" + lN);
  } else m.notas = rN || lN || "";
  m.eliminado = !!(loc.eliminado || rem.eliminado);
  const ul = [loc.ultimo_llamado||"", rem.ultimo_llamado||""].sort();
  if(ul[1]) m.ultimo_llamado = ul[1];
  if(loc.referidos || rem.referidos){
    // anfitriones: gana la versión con MÁS información en sus referidos
    const peso = arr => (arr||[]).reduce((t,r)=>t+(r.historial||[]).length+((r.notas||"").length?1:0),0) + (arr||[]).length;
    m.referidos = peso(loc.referidos) > peso(rem.referidos) ? loc.referidos : rem.referidos;
  }
  return m;
}
function mergeBase(local, remoto){
  if(!Array.isArray(remoto)) return remoto;
  if(!Array.isArray(local) || !local.length) return remoto;
  const locById = {}; local.forEach(c=>{ if(c && c.id!=null) locById[String(c.id)] = c; });
  const vistos = new Set();
  const out = remoto.map(r=>{
    const id = String(r && r.id); vistos.add(id);
    return mergeClienteBase(locById[id], r);
  });
  // clientes locales que lo remoto aún no tiene (recién creados, subida pendiente).
  // Los eliminados NO se re-agregan: así el vaciado de papelera remoto se respeta.
  local.forEach(c=>{ if(c && c.id!=null && !vistos.has(String(c.id)) && !c.eliminado) out.push(c); });
  return out;
}
// ── FUSIÓN DE NOTIFICACIONES: base = lo remoto (los borrados se propagan),
// leidoPor se UNE por id (marcar leída nunca se revierte) y las notificaciones
// locales muy recientes (subida pendiente) se conservan.
// Fusión protectora de COBRANZA: los clientes se comparan UNO POR UNO por su
// marca de tiempo _t — la versión más reciente gana. Así un borrado local
// (lápida _oculto con _t nuevo) NUNCA pierde contra la copia vieja de otro
// dispositivo, y los pagos externos se unen sin duplicar.
function mergeCobranza(local, remoto){
  const L = local || {}, R = remoto || {};
  const lcd = L.clientesData || {}, rcd = R.clientesData || {};
  const cd = { ...rcd };
  Object.keys(lcd).forEach(id => {
    const a = lcd[id], b = rcd[id];
    if (!b) { cd[id] = a; return; }                 // lo local que el remoto no tiene: se conserva
    if ((+a._t || 0) > (+b._t || 0)) cd[id] = a;    // gana el más reciente
  });
  const vistos = new Set();
  const pe = [...(R.pagosExternos || []), ...(L.pagosExternos || [])].filter(x => {
    const k = JSON.stringify([x.fecha, x.cuenta, x.nombre, x.monto]);
    if (vistos.has(k)) return false; vistos.add(k); return true;
  });
  return { ...R, clientesData: cd, pagosExternos: pe };
}
function mergeNotifs(local, remoto){
  if(!Array.isArray(remoto)) return remoto;
  const locById = {}; (local||[]).forEach(n=>{ if(n&&n.id) locById[n.id]=n; });
  const out = remoto.map(n=>{
    const l = locById[n.id];
    return l ? { ...n, leidoPor: [...new Set([...(n.leidoPor||[]), ...(l.leidoPor||[])])] } : n;
  });
  const ids = new Set(out.map(n=>n.id));
  const hace5min = Date.now() - 5*60*1000;
  (local||[]).forEach(n=>{
    if(n && n.id && !ids.has(n.id) && new Date(n.fecha||0).getTime() > hace5min) out.push(n);
  });
  return out.sort((a,b)=>String(b.fecha||"").localeCompare(String(a.fecha||""))).slice(0,100);
}
function mergeCallLog(local, remoto){
  const out = {};
  new Set([...Object.keys(local||{}), ...Object.keys(remoto||{})]).forEach(f=>{
    const L = clObj((local||{})[f]), R = clObj((remoto||{})[f]);
    const d = {};
    new Set([...Object.keys(L), ...Object.keys(R)]).forEach(ag=>{ d[ag] = Math.max(+L[ag]||0, +R[ag]||0); });
    out[f] = d;
  });
  return out;
}

// ─── ANTHROPIC API KEY ────────────────────────────────────────
// Para que funcionen la IA y el agendado FUERA de Claude,
// ⚠️ SEGURIDAD: la API key ya NO vive en el frontend. Todas las llamadas
// de IA pasan por el proxy /api/anthropic (Vercel), donde la key vive
// como variable de entorno ANTHROPIC_API_KEY. Nunca pongas una key aquí.
const ANTHROPIC_API_KEY = "";

const AI_HEADERS = () => ({
  "Content-Type": "application/json",
  ...(ANTHROPIC_API_KEY ? {
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  } : {}),
});

// Firebase SDK — carga dinámica (no necesita npm)
let _db = null;
let _auth = null;
async function ensureFirebase() {
  // Carga app + firestore + auth (compat) e inicializa la app una sola vez
  if (!window.firebase || !window.firebase.firestore) {
    await loadScript("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
    await loadScript("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js");
  }
  if (!window.firebase.auth) {
    await loadScript("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js");
  }
  if (!window.firebase.apps?.length) window.firebase.initializeApp(FIREBASE_CONFIG);
}
async function getDB() {
  if (_db) return _db;
  await ensureFirebase();
  _db = window.firebase.firestore();
  return _db;
}
async function getAuth() {
  if (_auth) return _auth;
  await ensureFirebase();
  _auth = window.firebase.auth();
  return _auth;
}
function loadScript(src) {
  return new Promise((res,rej)=>{
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s=document.createElement("script"); s.src=src; s.onload=res; s.onerror=rej;
    document.head.appendChild(s);
  });
}

const STATUS_COLORS = {
  rojo:     { bg:"bg-red-500",     text:"text-white",    label:"No interesado / No califica", hex:"#dc2626", border:"border-l-red-500",     cardBg:"bg-red-50/60",      style:{background:"#ef4444",color:"#fff"}         },
  verde:    { bg:"bg-green-600",   text:"text-white",    label:"Cita agendada",                hex:"#16a34a", border:"border-l-green-500",   cardBg:"bg-green-50/70",    style:{background:"#16a34a",color:"#fff"}         },
  amarillo: { bg:"bg-amber-400",   text:"text-gray-900", label:"Solo fines de semana",         hex:"#fbbf24", border:"border-l-amber-400",   cardBg:"bg-amber-50/70",    style:{background:"#f59e0b",color:"#1f2d3d"}      },
  azul:     { bg:"bg-[#7c3aed]",   text:"text-white",    label:"Llamar en las tardes",         hex:"#7c3aed", border:"border-l-purple-500",    cardBg:"bg-purple-50/60",     style:{background:"#7c3aed",color:"#fff"}         },
  naranja:  { bg:"bg-orange-500",  text:"text-white",    label:"Pendiente / Seguimiento",      hex:"#f97316", border:"border-l-orange-500",  cardBg:"bg-orange-50/60",   style:{background:"#f97316",color:"#fff"}         },
  morado:   { bg:"bg-purple-600",  text:"text-white",    label:"Solo mañanas",                 hex:"#9333ea", border:"border-l-purple-500",  cardBg:"bg-purple-50/60",   style:{background:"#9333ea",color:"#fff"}         },
  magenta:  { bg:"bg-pink-500",    text:"text-white",    label:"Archivar (no descartar)",      hex:"#ec4899", border:"border-l-pink-500",    cardBg:"bg-pink-50/60",     style:{background:"#ec4899",color:"#fff"}         },
  buzon:    { bg:"bg-teal-500",    text:"text-white",    label:"Buzón de voz",                 hex:"#0d9488", border:"border-l-teal-500",    cardBg:"bg-teal-50/60",     style:{background:"#0d9488",color:"#fff"}         },
  sin_estado:    { bg:"bg-slate-200",  text:"text-slate-700",label:"Sin estado",                   hex:"#cbd5e1", border:"border-l-slate-300",   cardBg:"bg-white",          style:{background:"#e2e8f0",color:"#475569"}      },
  numero_equivocado: { bg:"bg-slate-500", text:"text-white",    label:"Número equivocado",            hex:"#64748b", border:"border-l-slate-500",   cardBg:"bg-slate-50/70",    style:{background:"#64748b",color:"#fff"}         },
};

const CALL_RESULTS = [
  { id:"cita",        ico:"✅", label:"Cita agendada",  status:"verde",   bg:"#16a34a", text:"#fff" },
  { id:"no_contesto", ico:"📵", label:"No contestó",    status:"naranja", bg:"#f97316", text:"#fff" },
  { id:"buzon",       ico:"📭", label:"Buzón de voz",   status:"buzon",   bg:"#0d9488", text:"#fff" },
  { id:"no_interes",  ico:"❌", label:"No interesado",  status:"rojo",    bg:"#dc2626", text:"#fff" },
  { id:"despues",     ico:"⏰", label:"Llamar después", status:"naranja", bg:"#fbbf24", text:"#1f2d3d" },
  { id:"pendiente",      ico:"💬", label:"En proceso",        status:"naranja",           bg:"#7c3aed", text:"#fff" },
  { id:"num_equivocado", ico:"📵", label:"Número equivocado", status:"numero_equivocado", bg:"#64748b", text:"#fff" },
];
const APPT_RESULTS = [
  { id:"demo_venta",    ico:"💰", label:"Demo / venta",        bg:"#047857", text:"#fff" },
  { id:"demo_no_venta", ico:"🎬", label:"Demo / no venta",     bg:"#64748b", text:"#fff" },
  { id:"no_recibio",    ico:"🚪", label:"No recibió",          bg:"#dc2626", text:"#fff" },
  { id:"no_visito",     ico:"🚷", label:"No se visitó",        bg:"#9333ea", text:"#fff" },
  { id:"seguimiento",   ico:"📅", label:"Llamar más adelante", bg:"#f97316", text:"#fff" },
  { id:"reset",         ico:"🔄", label:"Reset (re-agendar)",  bg:"#0891b2", text:"#fff" },
  { id:"recompra",      ico:"✖", label:"Recompra (no pagó su deuda — no sacar cita)", bg:"#111827", text:"#fff" },
];
// Nota: APPT_RESULTS NO cambian el estado del cliente — solo registran
// el resultado de la cita de forma independiente (c.venta / c.resultado)

// Badge visual del resultado de cita
const RESULTADO_STYLE = {
  demo_venta:    { ico:"💰", label:"Demo / venta",        style:{background:"#047857",color:"#fff"} },
  demo_no_venta: { ico:"🎬", label:"Demo / no venta",     style:{background:"#64748b",color:"#fff"} },
  no_recibio:    { ico:"🚪", label:"No recibió",          style:{background:"#dc2626",color:"#fff"} },
  no_visito:     { ico:"🚷", label:"No se visitó",        style:{background:"#9333ea",color:"#fff"} },
  seguimiento:   { ico:"📅", label:"Llamar más adelante", style:{background:"#f97316",color:"#fff"} },
  reset:         { ico:"🔄", label:"Re-agendada",         style:{background:"#0891b2",color:"#fff"} },
  // Compatibilidad con datos antiguos guardados en Firebase:
  venta:         { ico:"💰", label:"Demo / venta",        style:{background:"#047857",color:"#fff"} },
  no_venta:      { ico:"🎬", label:"Demo / no venta",     style:{background:"#64748b",color:"#fff"} },
};

// ─── PRODUCTOS VENDIDOS + CAMBIO DE CARTUCHO ──────────────────
// Catálogo de productos. "Filtros de agua" tiene sub-opciones con
// el tiempo (en meses) en que toca cambiar el cartucho.
const PRODUCTOS_VENTA = [
  { id:"cocina",      ico:"🍳", label:"Sistema de cocina" },
  { id:"electronico", ico:"📺", label:"Electrónico" },
  { id:"purificador", ico:"💨", label:"Purificador de aire", meses:12 }, // mantenimiento anual
  { id:"filtros",     ico:"💧", label:"Filtros de agua / cartuchos", sub:[
    { id:"cart35",    label:"Frescapure 3.500",        meses:12 },
    { id:"cart55",    label:"Frescapure 5.500",        meses:24 },
    { id:"ducha",     label:"Ducha",                   meses:6  },
    { id:"prefiltro", label:"Pre-filtros",             meses:4  },
    { id:"prefw",     label:"Frescaflow",              meses:6  },
    { id:"carbon",    label:"Carbón y mineralizador",  meses:12 },
    { id:"osmosis",   label:"Ósmosis inversa",         meses:24 },
  ]},
  { id:"premios",   ico:"🎁", label:"Premios" },
  { id:"repuestos", ico:"🔩", label:"Repuestos" },
];
// Resuelve producto+sub a { label, meses }. meses>0 ⇒ genera recordatorio de mantenimiento.
function resolveProducto(prodId, subId){
  const p = PRODUCTOS_VENTA.find(x=>x.id===prodId);
  if(!p) return { label:"", meses:0 };
  if(p.sub){
    const s = p.sub.find(x=>x.id===subId);
    return s ? { label:`${p.label} · ${s.label}`, meses:s.meses } : { label:p.label, meses:p.meses||0 };
  }
  return { label:p.label, meses:p.meses||0 };
}
// Suma meses a una fecha ISO y devuelve un objeto Date.
function addMeses(fechaISO, meses){
  const d = new Date(fechaISO);
  if(isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + Number(meses||0));
  return d;
}
// Dada una fecha de venta y el intervalo, devuelve el PRÓXIMO cambio (recurrente)
// a partir de hoy, y cuántos ciclos ya se cumplieron.
function proximoCambioCartucho(fechaVentaISO, meses, hoy=new Date()){
  if(!meses || meses<=0) return null;
  const base = new Date(fechaVentaISO);
  if(isNaN(base.getTime())) return null;
  // Ciclos: venta + k·meses. El cambio ACTIVO es el último ciclo que ya venció
  // (queda pendiente de hacer → aparece como VENCIDO) o, si ninguno venció
  // todavía, el primer ciclo futuro. Así los atrasados nunca se "esconden".
  let k = 1;
  let fecha = addMeses(fechaVentaISO, meses);
  if(!fecha) return null;
  while(k < 600){
    const sig = addMeses(fechaVentaISO, meses*(k+1));
    if(!sig || sig > hoy) break; // el siguiente ciclo aún no llega → nos quedamos en k
    k++; fecha = sig;
  }
  return { fecha, ciclo: k };
}

// Escanea todos los clientes (de las 4 bases) + appts y devuelve la lista de
// cambios de cartucho próximos o vencidos (dentro de la ventana de aviso).
function calcularCartuchos(flatClientes, appts, ventanaDias=30, hoy=new Date()){
  const out = [];
  const push = (nombre, telefono, prodLabel, meses, fechaVenta, origen) => {
    if(!meses || meses<=0 || !fechaVenta) return;
    const prox = proximoCambioCartucho(fechaVenta, meses, hoy);
    if(!prox || !prox.fecha) return;
    const diasFaltan = Math.round((prox.fecha - hoy)/86400000);
    if(diasFaltan <= ventanaDias){ // próximos (≤ventana) o ya vencidos (negativo)
      out.push({ nombre:nombre||"(Sin nombre)", telefono:telefono||"", producto:prodLabel||"", meses, fechaVenta, proxFecha:prox.fecha, diasFaltan, vencido:diasFaltan<0, origen });
    }
  };
  // Ventas registradas en el historial de los clientes
  (flatClientes||[]).forEach(c=>{
    (c.historial||[]).forEach(h=>{
      if((h.cita_resultado==="demo_venta"||h.cita_resultado==="venta") && h.cartucho_meses>0){
        push(c.nombre||c.anfitrion, c.telefono||c.anfitrion_telefono, h.producto, h.cartucho_meses, h.fecha, "cliente");
      }
    });
  });
  // Ventas registradas en citas de la agenda
  (appts||[]).forEach(a=>{
    if((a.resultado==="demo_venta"||a.resultado==="venta") && a.cartucho_meses>0){
      push(a.nombre, a.telefono, a.producto, a.cartucho_meses, a.fecha, "agenda");
    }
  });
  return out.sort((x,y)=>x.proxFecha - y.proxFecha);
}

// ─── CONTEO UNIFICADO DE VENTAS / DEMOS (fuente única de verdad) ──
// Cuenta demostraciones, ventas y volumen desde las citas de la agenda
// (appts) + el historial de los clientes. La usan Control de actividad,
// Estadísticas, Incentivos e Inicio para que TODOS los números cuadren.
//   appts    = arreglo de citas de la agenda
//   clientes = arreglo de clientes (con .historial)
//   enP      = (fechaISO)=>bool → ¿la fecha cae en el periodo?
//   agente   = (opcional) cuenta solo lo registrado por ese agente
function contarVentasDemos({ appts=[], clientes=[], enP=()=>true, agente="" }={}){
  let demos=0, ventas=0, volumen=0;
  (appts||[]).forEach(a=>{
    if(a._sincronizado) return; // ya atribuida a un cliente → se cuenta vía su historial
    if(!enP(a.fecha)) return;
    if(agente && a.agente && a.agente!==agente) return;
    if(a.resultado==="demo_venta"||a.resultado==="venta"){ ventas++; demos++; volumen+=Number(a.monto)||0; }
    else if(a.resultado==="demo_no_venta"||a.resultado==="no_venta"){ demos++; }
  });
  (clientes||[]).forEach(c=>(c.historial||[]).forEach(h=>{
    if(!enP(h.fecha)) return;
    if(agente && h.agente && h.agente!==agente) return;
    if(h.cita_resultado==="demo_venta"||h.cita_resultado==="venta"){ ventas++; demos++; volumen+=Number(h.monto)||0; }
    else if(h.cita_resultado==="demo_no_venta"||h.cita_resultado==="no_venta"){ demos++; }
  }));
  return { demos, ventas, volumen, cierre: demos>0?Math.round((ventas/demos)*100):0 };
}

// ─── HELPERS DE HISTORIAL ─────────────────────────────────────
// Crea una entrada de historial con fecha/hora automática.
function makeHistorialEntry({ tipo="llamada", estado="", notas="", agente="", cita_resultado="", monto=0, producto="", cartucho_meses=0 } = {}) {
  return {
    id: genId(),
    tipo,                       // "llamada" | "estado" | "cita"
    estado,                     // estado del semáforo en ese momento
    notas,                      // nota libre
    agente,                     // quién lo registró
    cita_resultado,             // demo_venta / demo_no_venta / no_recibio / no_visito / seguimiento
    monto: monto ? Number(monto) : 0, // valor de la venta (solo demo_venta)
    producto,                   // producto vendido (label) — solo demo_venta
    cartucho_meses: cartucho_meses ? Number(cartucho_meses) : 0, // meses para cambio de cartucho (0 = sin recordatorio)
    fecha: new Date().toISOString(),
  };
}
// Agrega una entrada de historial al cliente con ese id, dentro de un array.
function addHistorialEntry(arr, id, entry) {
  return (arr||[]).map(x => x.id===id ? {...x, historial:[...(x.historial||[]), entry]} : x);
}
// Elimina UNA entrada del historial de un cliente (por id de entrada o fecha).
// Deja un registro mínimo de que se eliminó. NO borra al cliente ni sus datos.
function deleteHistorialEntry(arr, clienteId, entryKey) {
  return (arr||[]).map(x => {
    if(x.id!==clienteId) return x;
    const nuevoHist=(x.historial||[]).filter(h=>(h.id||h.fecha)!==entryKey);
    return {...x, historial:nuevoHist, actualizado:new Date().toISOString()};
  });
}

// ─── NOTAS ────────────────────────────────────────────────────
// Agrega una nota nueva: se vuelve la última visible y la anterior pasa al historial.
function agregarNota(cliente, texto, agente="") {
  const t = (texto||"").trim();
  if(!t) return cliente;
  const nueva = { texto:t, fecha:new Date().toISOString(), agente };
  const notasPrev = cliente.notas || [];
  return {
    ...cliente,
    ultimaNota: t,
    notas: [...notasPrev, nueva],   // historial completo (no borra nada)
    actualizado: new Date().toISOString(),
  };
}

const emptyClient = () => ({
  id: genId(),
  nombre:"", cuenta:"", direccion:"", ciudad:"", cp:"", producto:"", telefono:"",
  telefonoCasa:"", telefonoTrabajo:"", telefonoMovil:"",   // teléfonos separados
  vendedor:"", nivelCliente:"", limiteCredito:"", saldoActual:"", // datos financieros
  productos:[],                                   // lista de productos comprados
  otrosDetalles:"",                               // otros datos útiles
  observaciones:"", detalles:"", estado:"sin_estado", venta:false,
  ultimaNota:"",                                  // última nota visible
  notas:[],                                       // historial de notas {texto, fecha, agente}
  resultado:"", resultado_detalle:"",
  asignado_a:"",                                  // quién es responsable del cliente
  proximo_seguimiento:"",                         // fecha del próximo seguimiento (YYYY-MM-DD)
  historial:[],                                   // historial de contactos
  eliminado:false,                                // soft-delete (papelera)
  actualizado:"",                                 // última actualización
  fecha_contacto: hoyLocal(), creado: new Date().toISOString(),
});
const emptyReferido = () => ({
  id: genId(), anfitrion:"", regalo:"",
  anfitrion_telefono:"", anfitrion_ciudad:"", anfitrion_cuenta:"", anfitrion_detalle:"",
  referidos:[{ nombre:"",parentesco:"",telefono:"",direccion:"",ciudad:"",cp:"",producto:"",observaciones:"",detalles:"",estado:"sin_estado",ultimaNota:"",notas:[],historial:[],proximo_seguimiento:"",creado:new Date().toISOString(),actualizado:"" }],
  estado:"sin_estado", venta:false, creado: new Date().toISOString(),
});
const emptyProspecto    = () => ({ ...emptyClient(), fuente:"" });
const emptyDistribucion = () => ({ ...emptyClient(), ultima_compra:"" });

// ── EQUIPO ─────────────────────────────────────────────────
const AGENTES = ["Tomas", "Angie", "Supervisora", "Agente de llamadas"];

// ── MATRIZ DE ROLES v2 (5 roles oficiales) ─────────────────────────
// Los roles viejos (Administrador/a, Asistente, Agente de llamadas,
// Supervisora telemarketing…) se MIGRAN lógicamente con normalizarRol:
// los datos de usuarios y cuentas NO se tocan.
const ROLES_APP = ["Distribuidor","Supervisor","Telemarketing","Cobranza","Reclutador"];
const normalizarRol = (r) => {
  const x = String(r||"").toLowerCase();
  if(x.includes("distribuidor")||x.includes("administrador")||x.includes("administradora")||x==="admin") return "Distribuidor";
  if(x.includes("supervis")) return "Supervisor";
  if(x.includes("telemarket")||x.includes("agente")||x.includes("asistente")) return "Telemarketing";
  if(x.includes("cobran")) return "Cobranza";
  if(x.includes("reclut")) return "Reclutador";
  return "Telemarketing"; // rol desconocido → básico
};
const PERMISOS_ROL = {
  Distribuidor:  { tabs:"*",                                     exportar:true,  crearIncentivos:true  },
  Supervisor:    { tabs:"*",                                     exportar:true,  crearIncentivos:true  },
  Telemarketing: { tabs:"*", excepto:["cobranza"],               exportar:false, crearIncentivos:false },
  Cobranza:      { tabs:["inicio","cobranza","agenda"],          exportar:false, crearIncentivos:false },
  Reclutador:    { tabs:["inicio","reclutamiento","agenda"],     exportar:false, crearIncentivos:false },
};
const puedeVerTabRol = (rol, tabId) => {
  const p = PERMISOS_ROL[normalizarRol(rol)] || PERMISOS_ROL.Telemarketing;
  if(p.tabs === "*") return !(p.excepto||[]).includes(tabId);
  return p.tabs.includes(tabId);
};
const puedeExportarRol = (rol) => (PERMISOS_ROL[normalizarRol(rol)]||{}).exportar === true;
const puedeCrearIncentivosRol = (rol) => (PERMISOS_ROL[normalizarRol(rol)]||{}).crearIncentivos === true;

// Usuarios con rol y clave por defecto (la clave se puede cambiar en Configuración)
// (USUARIOS y CLAVES_DEFAULT eliminados — sistema de claves locales retirado.)

// ── Roles disponibles para usuarios creados por el admin ──
const ROLES_DISPONIBLES = ["Distribuidor","Supervisor","Telemarketing","Cobranza","Reclutador"]; // = ROLES_APP

// ─── CUENTAS (Firebase Auth) — correo → identidad y rol ───────
// El login real lo hace Firebase. Aquí cada correo autorizado se
// mapea a su NOMBRE (lo que se muestra y se guarda) y su ROL
// (define permisos). Para dar de alta a alguien nuevo: créalo en
// Firebase Console (Authentication) y agrégalo también aquí.
// Si un correo NO está en esta lista, la app no le da acceso.
// ══ FIREBASE MANDA ═══════════════════════════════════════════════════════════
// Los usuarios YA NO viven en el código. Se administran desde el panel
// Configuración → Cuentas, y se guardan en Firebase (state.cuentasCustom).
// Para dar de alta a alguien: (1) créalo en Firebase Authentication,
// (2) agrega su correo a las reglas de Firestore, (3) agrégalo en el panel.
// No hace falta redesplegar nunca más.

// 🔑 LLAVE MAESTRA — la ÚNICA cuenta que queda en el código.
// Es el seguro contra quedarse fuera: si se borra mal una cuenta o Firebase
// devuelve la lista vacía, este correo SIEMPRE entra como Distribuidor y
// puede reparar todo desde el panel de Cuentas.
const CUENTA_ROOT = "florestomas323@gmail.com";
const CUENTA_ROOT_DATOS = { nombre:"Tomas", rol:"Distribuidor" };

// 🌱 SEMILLA — se copia a Firebase UNA SOLA VEZ (la primera vez que se abre la
// app con la lista de cuentas vacía). Después de esa migración este arreglo ya
// no se usa jamás: la fuente de verdad pasa a ser Firebase.
const SEMILLA_CUENTAS = [
  { email:"florestomas323@gmail.com",         nombre:"Tomas",           rol:"Distribuidor" },
  { email:"paredesangiemar@gmail.com",        nombre:"Angie",           rol:"Distribuidor" },
  { email:"yelitzaurdaneta1978@gmail.com",    nombre:"Yelitza",         rol:"Telemarketing" },
  { email:"milateamtlmk@gmail.com",           nombre:"Mila",            rol:"Supervisora telemarketing" },
  { email:"jovannadelgadobella.19@gmail.com", nombre:"Jovanna Delgado", rol:"Cobranza" },
  { email:"jeanmoreno2404@gmail.com",         nombre:"Jean Moreno",     rol:"Cobranza" },
  { email:"lisbethvillasmil3@gmail.com",      nombre:"Lisbeth",         rol:"Telemarketing" },
];
// Mapa dinámico de cuentas (correo→{nombre,rol}) que vive en Firebase.
// Se llena en runtime desde state.cuentasCustom para no tener que redesplegar.
let CUENTAS_DINAMICAS = {};
function setCuentasDinamicas(arr){
  const m={};
  (arr||[]).forEach(u=>{ const e=(u.email||"").trim().toLowerCase(); if(e) m[e]={ nombre:u.nombre||e, rol:u.rol||"Telemarketing" }; });
  CUENTAS_DINAMICAS=m;
}
// Todas las cuentas autorizadas = fijas (código) + dinámicas (Firebase).
function todasLasCuentas(){ return { [CUENTA_ROOT]: CUENTA_ROOT_DATOS, ...CUENTAS_DINAMICAS }; }
function cuentaAutorizada(email){
  const e=(email||"").trim().toLowerCase();
  // Firebase manda. La llave maestra entra siempre, pase lo que pase.
  return e===CUENTA_ROOT || !!CUENTAS_DINAMICAS[e];
}
function cuentaDeEmail(email){
  const e=(email||"").trim().toLowerCase();
  // Firebase manda; si la llave maestra no está en Firebase, se usa su rol fijo.
  if(CUENTAS_DINAMICAS[e]) return CUENTAS_DINAMICAS[e];
  if(e===CUENTA_ROOT)      return CUENTA_ROOT_DATOS;
  return { nombre: e || "Usuario", rol: "Telemarketing" };
}

// Lista efectiva de usuarios = fijos (nunca se borran) + dinámicos (Firebase).
// Mantiene compatibilidad: los usuarios actuales siempre funcionan.

const SEED = {
  agregados:[
    { id:1, nombre:"María García", cuenta:"RP-4421", direccion:"123 Oak St, Temple TX", producto:"Juego Innové 5 pzs", telefono:"(254) 555-0101", observaciones:"Interesada en el set completo", detalles:"Visita sábado", estado:"verde", venta:false, fecha_contacto:"2026-06-08", creado:"2026-06-08T10:00:00Z" },
    { id:2, nombre:"Juan López",   cuenta:"RP-4422", direccion:"456 Elm Ave, Waco TX",  producto:"Filtro de agua", telefono:"(254) 555-0102", observaciones:"Llamar después del trabajo", detalles:"", estado:"azul", venta:false, fecha_contacto:"2026-06-07", creado:"2026-06-07T14:00:00Z" },
  ],
  referidos:[],
  prospectos:[
    { id:3, nombre:"Ana Martínez", cuenta:"", direccion:"789 Pine Rd, Austin TX", producto:"Purificador", telefono:"(512) 555-0201", observaciones:"Vino por Facebook", detalles:"", fuente:"Facebook", estado:"naranja", venta:false, fecha_contacto:"2026-06-09", creado:"2026-06-09T09:00:00Z" },
  ],
  distribucion:[
    { id:4, nombre:"Carlos Pérez", cuenta:"RP-3310", direccion:"321 Cedar Ln, Temple TX", producto:"Juego Clásico 7 pzs", telefono:"(254) 555-0301", observaciones:"Cliente leal", detalles:"Interesado en filtro", estado:"naranja", venta:true, ultima_compra:"2025-12-15", fecha_contacto:"2026-06-01", creado:"2025-12-15T00:00:00Z" },
  ],
};

// ─── SHARED STATE — Firebase Firestore con onSnapshot (tiempo real verdadero) ──
function useSharedState(authReady) {
  const initial = {
    agregados:[], referidos:[],
    prospectos:[], distribucion:[],
    callLog:{}, appts:[], cumpleanos:[], incentivos:[], rutas:[],
    cofreConfig:{ activo:true, niveles:COFRE_NIVELES_DEFAULT.map(n=>({...n,premios:[]})) }, cofreAperturas:[], respaldos:[],
    usuariosCustom:[], preguntasSeguridad:{}, reclutamiento:[], controlCierres:[], cuentasCustom:[], cumpleMsgTpl:""
  };
  const [state, setStateRaw] = useState(()=>{
    try { const s=localStorage.getItem("crm_fb_v1"); if(s) return JSON.parse(s); } catch {}
    return initial;
  });
  const [synced,  setSynced]  = useState(false);
  const [fbError, setFbError] = useState("");
  const lastJsonDoc = useRef({});   // por documento: último JSON visto/escrito (corta ecos)
  const unsub       = useRef(null);
  // ── RECONEXIÓN AUTOMÁTICA: si la escucha de Firebase muere, se re-suscribe sola ──
  const [connTick, setConnTick] = useState(0); // cambiarlo re-dispara la conexión
  const retryTimer = useRef(null);
  const retryDelay = useRef(5000);             // 5s → 10s → 20s → … máx 60s
  const programarReintento = useCallback(()=>{
    clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(()=>{ setConnTick(t=>t+1); }, retryDelay.current);
    retryDelay.current = Math.min(retryDelay.current * 2, 60000);
  },[]);
  const reintentarAhora = useCallback(()=>{
    clearTimeout(retryTimer.current);
    retryDelay.current = 5000;
    setFbError("📡 Reintentando conexión…");
    setConnTick(t=>t+1);
  },[]);
  const primerSnapRef = useRef(false); // espejo síncrono de primerSnap para el overlay del caché
  // Overlay del caché grande: si IndexedDB tiene una copia y aún no llegó nada
  // de Firebase, se muestra al instante (elimina el "abre con menos datos").
  useEffect(()=>{
    let vivo = true;
    idbCache.get("estado").then(v => {
      if(vivo && v && !primerSnapRef.current) setStateRaw(s => primerSnapRef.current ? s : v);
    });
    return () => { vivo = false; };
  },[]);
  const [primerSnap, setPrimerSnap] = useState(false); // ¿ya llegó el primer snapshot? (estado, para re-disparar el guardado)

  // Conectar, MIGRAR si hace falta y escuchar cambios en tiempo real
  useEffect(()=>{
    if(!authReady) return;
    let alive = true;
    getDB().then(db=>{
      if(!alive) return;
      const col = db.collection(FIRESTORE_COL);

      // ── MIGRACIÓN AUTOMÁTICA (en segundo plano, SIN bloquear la escucha) ──
      // Corre una sola vez en la vida del proyecto. Va en paralelo para que la
      // app EMPIECE A RECIBIR DATOS de inmediato aunque la conexión sea lenta.
      (async()=>{
        try{
          const guia = await col.doc(DOC_MISC).get();
          if(!guia.exists){
            const legado = await col.doc("state").get();
            const base = (legado.exists && legado.data()?.payload) ? legado.data().payload : initial;
            const docs = partirEstado(base);
            const batch = db.batch();
            Object.keys(docs).forEach(id => batch.set(col.doc(id), { payload: docs[id] }));
            await batch.commit();
          } else {
            const guia2 = await col.doc("sec_agregados_1").get();
            if(!guia2.exists){
              const V1 = ["agregados","referidos","prospectos","distribucion","appts","cobranza","reclutamiento"];
              const base = { ...(guia.data()?.payload || {}) };
              for(const sn of V1){
                const d = await col.doc("sec_" + sn).get();
                if(d.exists && d.data()?.payload !== undefined) base[sn] = d.data().payload;
              }
              const docs = partirEstado(base);
              const batch = db.batch();
              Object.keys(docs).forEach(id => batch.set(col.doc(id), { payload: docs[id] }));
              await batch.commit();
            } else {
              // Migración V2→V3: la AGENDA pasa de 1 documento (límite 1 MB, se llenó)
              // a 5 fragmentos. Corre una sola vez; sec_appts queda como respaldo.
              const guiaA = await col.doc("sec_appts_1").get();
              if(!guiaA.exists){
                const viejo = await col.doc("sec_appts").get();
                const arr = (viejo.exists && Array.isArray(viejo.data()?.payload)) ? viejo.data().payload : [];
                const frags = fragArray(arr);
                const batch = db.batch();
                for(let i=0;i<N_FRAG;i++) batch.set(col.doc("sec_appts_"+(i+1)), { payload: frags[i] });
                await batch.commit();
              }
            }
          }
        }catch(e){ /* si la migración falla (p. ej. reglas), el onSnapshot igual escucha */ }
      })();

      // ── Escucha en tiempo real de TODOS los documentos de sección (INMEDIATA) ──
      unsub.current = col.onSnapshot(qs=>{
        const cambios = {};
        let hubo = false;
        const LEGADO_V1 = ["sec_agregados","sec_referidos","sec_prospectos","sec_distribucion","sec_cobranza","sec_appts"];
        qs.forEach(doc=>{
          if(doc.id === "state" || LEGADO_V1.includes(doc.id)) return; // legados: solo respaldo
          const payload = doc.data()?.payload;
          if(payload === undefined) return;
          const json = JSON.stringify(payload);
          if(json !== lastJsonDoc.current[doc.id]){
            lastJsonDoc.current[doc.id] = json;
            cambios[doc.id] = payload;
            hubo = true;
          }
        });
        primerSnapRef.current = true;
        setPrimerSnap(true);
        if(hubo){
          setStateRaw(s=>{
            // 1) ¿Qué SECCIONES tocaron los documentos que cambiaron? Solo esas se
            //    reconstruyen — un snapshot de cobranza jamás toca agregados, y las
            //    ediciones locales aún no guardadas de otras secciones quedan intactas.
            const seccionesTocadas = new Set();
            let tocoMisc = false;
            Object.keys(cambios).forEach(id=>{
              if(id === DOC_MISC){ tocoMisc = true; return; }
              const m = id.match(/^sec_(.+?)(?:_\d+)?$/);
              if(m) seccionesTocadas.add(m[1]);
            });
            // 2) Mapa completo (últimos JSON conocidos, ya incluyen los cambios)
            const mapa = {};
            Object.keys(lastJsonDoc.current).forEach(id=>{
              if(id === "state") return;
              try { mapa[id] = JSON.parse(lastJsonDoc.current[id]); } catch {}
            });
            const todo = unirDocs(mapa);
            const parcial = {};
            if(tocoMisc) Object.assign(parcial, mapa[DOC_MISC] || {});
            seccionesTocadas.forEach(sec=>{ if(todo[sec] !== undefined) parcial[sec] = todo[sec]; });
            // 3) FUSIONES PROTECTORAS: nada de lo escrito localmente se pierde.
            //    callLog por máximo; historial/notas de las bases se UNEN por cliente;
            //    notificaciones unen leidoPor (marcar leída nunca se revierte).
            if(Object.prototype.hasOwnProperty.call(parcial, "callLog")) parcial.callLog = mergeCallLog(s.callLog, parcial.callLog);
            ["agregados","referidos","prospectos","distribucion","reclutamiento"].forEach(sec=>{
              if(Object.prototype.hasOwnProperty.call(parcial, sec)) parcial[sec] = mergeBase(s[sec], parcial[sec]);
            });
            if(Object.prototype.hasOwnProperty.call(parcial, "cobranza")) parcial.cobranza = mergeCobranza(s.cobranza, parcial.cobranza);
            if(Object.prototype.hasOwnProperty.call(parcial, "notificaciones")) parcial.notificaciones = mergeNotifs(s.notificaciones, parcial.notificaciones);
            if(Object.prototype.hasOwnProperty.call(parcial, "cumpleNotifs")) parcial.cumpleNotifs = { ...(parcial.cumpleNotifs||{}), ...(s.cumpleNotifs||{}) };
            // Reparar IDs duplicados/vacíos al recibir (no destructivo).
            const fusionado = repararIdsEstado({ ...s, ...parcial });
            idbCache.set("estado", fusionado);
            try { localStorage.removeItem("crm_fb_v1"); } catch {} // el caché viejo (congelado por cuota) se retira
            return fusionado;
          });
        }
        // Conexión viva: se limpia el aviso de conexión (los ⚠️ de guardado se conservan)
        retryDelay.current = 5000;
        setFbError(f => (f && (f.startsWith("📡") || f.startsWith("⛔"))) ? "" : f);
        setSynced(true);
      }, err=>{
        // La escucha MURIÓ (Firestore no la revive sola). Antes esto era permanente
        // y silencioso: la persona quedaba trabajando solo en su teléfono.
        const code = String(err?.code||"");
        if(code === "permission-denied"){
          setFbError("⛔ Este usuario NO tiene permiso en las reglas de Firestore — sus cambios no llegan a la nube. Avísale a Tomas.");
        } else {
          setFbError("📡 Sin conexión a Firebase — trabajando local. Reintentando automáticamente…");
        }
        setSynced(true);
        unsub.current?.(); unsub.current = null;
        programarReintento();
      });
    }).catch(()=>{
      setFbError("📡 Error al cargar Firebase — reintentando automáticamente…");
      setSynced(true);
      programarReintento();
    });
    return ()=>{ alive=false; clearTimeout(retryTimer.current); unsub.current?.(); };
  },[authReady, connTick]);

  // Guardar en Firestore cuando el estado cambia localmente.
  // SOLO se escriben los documentos cuya sección realmente cambió:
  // editar un cliente de Agregados ya no re-escribe Cobranza ni la Agenda.
  useEffect(()=>{
    if(!synced) return;
    // No subir NADA hasta haber recibido el primer snapshot: así nunca escribimos
    // una base reconstruida de forma incompleta encima de la de la nube.
    if(!primerSnap) return;
    const docs = partirEstado(state);
    const pendientes = [];
    Object.keys(docs).forEach(id=>{
      const json = JSON.stringify(docs[id]);
      if(json !== lastJsonDoc.current[id]){
        const previo = lastJsonDoc.current[id]; // para desmarcar si el guardado falla
        lastJsonDoc.current[id] = json;
        pendientes.push([id, docs[id], previo, json]);
      }
    });
    if(!pendientes.length) return;
    idbCache.set("estado", state);
    getDB().then(db=>{
      const col = db.collection(FIRESTORE_COL);
      pendientes.forEach(([id, payload, previo, json]) => col.doc(id).set({ payload }).catch(err=>{
        // Falló el guardado: se DESMARCA para que el próximo cambio lo reintente
        // (antes quedaba marcado como guardado y el fallo era permanente y silencioso).
        if(lastJsonDoc.current[id] === json) lastJsonDoc.current[id] = previo;
        const nombre = id === DOC_MISC ? "configuración" : id.slice(4);
        if(String(err?.message||"").toLowerCase().includes("size") || String(err?.message||"").toLowerCase().includes("bytes") || String(err?.code||"")==="invalid-argument"){
          setFbError("⚠️ La sección \"" + nombre + "\" superó su límite de tamaño — el último cambio NO se guardó en la nube. Avísale a Tomas.");
        } else if(String(err?.code||"")==="permission-denied"){
          setFbError("⛔ Este usuario NO tiene permiso para GUARDAR en la nube (reglas de Firestore) — sus cambios quedan solo en este teléfono. Avísale a Tomas.");
        } else {
          setFbError("⚠️ No se pudo guardar \"" + nombre + "\" en la nube (¿sin conexión?). Se reintentará automáticamente.");
        }
      }));
    }).catch(()=>{});
  },[state, synced, primerSnap, connTick]); // connTick: al reconectar se re-empujan los pendientes

  return [state, setStateRaw, synced, fbError, reintentarAhora];
}

// ─── UI PRIMITIVES ────────────────────────────────────────────
const inpLight = "w-full rounded-xl px-3.5 py-2.5 text-sm bg-[#0B0E12] text-[#F4F4F1] border border-white/12 focus:outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20 transition placeholder:text-[#717680]";

function PrimaryBtn({ children, onClick, type, disabled, full }) {
  return (
    <button type={type||"button"} onClick={onClick} disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-bold tracking-tight hover:brightness-95 active:scale-[0.98] transition disabled:opacity-40 disabled:pointer-events-none ${full?"w-full":""}`}
      style={{background:RP.btn,color:RP.btnText}}>{children}</button>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col" style={{background:RP.navy,border:`1px solid ${RP.silver2}`}}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <h2 className="text-lg font-extrabold tracking-tight text-[#F4F4F1]" style={{fontFamily:SERIF}}>{title}</h2>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-white/10 text-[#A5A9B0] text-2xl transition">&times;</button>
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children, required }) {
  return (
    <div className="mb-3">
      <label className="block text-[11px] font-bold uppercase tracking-[0.14em] text-[#A5A9B0] mb-1.5">
        {label}{required && <span className="text-[#F87171] ml-1">*</span>}
      </label>
      {children}
    </div>
  );
}

// Royal Prestige logo (real) + Telemarketing Impact Enterprises
const LOGO_SRC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAABJs0lEQVR42rW9Z7hlRZUGvFbV3ifdfDvc20AHmtjQTZAkOQ44IIwJdRQFFERFZ3Scb0YZZ9THQfCbZMAs4sigzKgYSAZyaBtpuoGGzt10Tjefe9LeVbXW96N2qL3PuY0zz/OdR5vue0/Yp3bVCu9617tQSg8AEZkZoof9CyIwJ/8CYACM/wSA6OkIyQPj5zEm/4lfjJh/mvOezm94hl/l/5leJTAAMgIytD/af86YXufBPyX3e3Q+NHet2LY+ufdBzP3Nebmw/2BGu27Oe7qrn3wMOvcHOy2efRe0q2+fgQhty9dhsdwPy6wac6eXY/ShyAAYv5idlzjPcl7FAOy+P85wMfZ3mHtS5vZw9IbJ+9kryT8t2SfOt3Q+X0qvw71H91tw232eeRHz72IXL7o9HfdjsvDOb9Nz5j4hOUu5zfanP17v+fwnbJROB8VdfsT8Xcy+0FoWjLeniJ6RLC8jAzAn5oeh877k1/uCyeZJf5jdpzPtF85uWI62MWOy+ukHIM68Rp2vFjG/xtjpr/nnYO5tk2+Ezi6PjW+HxUlvhl1YjnebyBx0gOwexewZxtQBcMfvmVtNnvl0M7RZbcfoYgcbgdmjkb2OjgbKuW50fVS7o2j/Apz9cfZzMLZAjDPdwBlOmuMDABmYAYXw8OAv6uCpOv6uk41iTg4Y552VY2Aw5zXbPBgCIgKgEBmjzswIuZcAxw9g5qwPbD9usa1FbD99nd0x53wh5+9gx1gjf7wST+Clt/N1DB47fjh9X8wvPbbd8ZmdOSaWPwpm3JsphECBiIIMaa0YCP53D5TSk0IiIhORtapxZNcWQbQvDfKMThrbwir3ruBBn9/pKrMByP/5kbpGTC1+cuQ4Xu9MsJMcgfiVKIUARK01kU6e19XVPTQ0d+7coaGhoaGhuQMDA93d3b3dPYViARCN1o1Go1avT05OHYge+/fu3Tc2Nua6DN8roEAiYuIkSM5cE+aiFGyzSx1OQDYawNf15HF4HxtHKTx2Niu/TujQfhL/FyEEtkVUsYVGIQQihGFofyyld+SRR5x44kknnXTicUuOW3T4otmzZ5dLFd/3pRDMTBTtatchIyIRa6Uazcbk5OSevXs2b978yitr1qxZs379hvHxMftkzytIIQwRMyV7gLOXiJ39U6dAIzJgWesVR+FtTiqfTsU3AA9q2/ng/gAPsuL5VASQkWOjjUIIgRiEIQABwODArLPOOvP8C84/+6yzFy9e3NvbC4BBELSarVCFxpAxmsjYxQYAImKO9jKRIWJEa83Qk7JYLBZLRc/ztNGjo6Ovvvrq448//vTTT69bt9Zenu8XEdEYk3hzjE9rzrlyh5gKXy+Pw/boM/Lu7lsL4f1vjMxMy533dTNt/OS0CSERIQwDAOjt7b3wgguvvPLN55xz7mHz50shm81mo9FQSkc3DdEm6xwFcZxxtpmfROeCiYwxkbVB9Dy/q1LxC4VGs7Fh/brf/f53v/nNbzdu3AAAUvpSCqPJTe95xrwh76cxY2x55gOfsx9R1Pq/ugHQySbm7wG/XnYgpGQGrQMAWLbshPe85y//4qq/OPzwxcwwPV1tNpsAIKW0i05MCNHSEyXLTWkgbP9BhIjMwEQMydOiW8NMRMYYMoakFD3d3eVKpdGo/+EPK+758X89+ujjxighPM/zjNHMr2tFM4BENrs86A3IHKTYOyY+oNNNntHEY+JVO++NTmcFQQoBgEoFAHDeeed/9CMfuexNb+ru6q5Wq41Gk5mFwGQ727jTvlUUxBBBlCQyA0Ubj4GYopMQ/ZHeHop8BSc2hpmMMWEYSiH7+/tLldKmTZvuvvtH//M/P202G1J40pNGG/i/ZNoOhJBx8e13zvl5egI4ztQ4QW86+1VMXoCYHD/ufDiSQB6llGHYAoALzr/gk3/zyT/7s0ulkOPj41prIUQMByIzZe+BG9oDMUG8mnZlk51OxEnIG9khZiYmYDIU/YqBmIjI/kobTUQ9vT19vX07du744Q/vuueeHwdBy/eL0YnLbubs10ydr7u47V7c9Su5rcnMKISXAQsObgDjQ3cQu9h+uVJKYwyRPvHEk/7hH2658s1XIcDE1BQRCYF2oeJNmkTVztICcLKR7RuiQClE5BUi02+M0cYYrWNvkPg7a6Ns6BQ7iej3AMBKKaVUT0/vnLmzN27c+B9f+Y+HHnwQAAqFotamfSHwYBkrzOAM2uKfJEUVwmuPjV4nj4jNXi7Ohzb3ZOPLUAVdla5b/uGWj3/8ryqVyujoGJGRwrMLm/Go8ZVZa05EQohCoeD7vud5KFCFKgiCIAjCMGy1bGhkEND3/UKhUCwWfd+3oao2ptVqBUGglGZmu1fj0BMiq8Rk0wIUaAypMOju6Zk1a/DpZ57+51tv3bJ5sycLgEBEbvyOM2y4th0MM6berisQ0ovx3o5xrgPMZmFhnBkbtP8U8ca/7LI3ffn220886cSx0XGttfQ8jtedHMdqN6Yxmpn9QqFSqfie12g2RkYObN++ffPmLa+99tquXbtHDhyYmJyo1+tBEMZYA0ghCsVCb2/f4ODg3DlzFixYcMQRRyxcuGB4eLi7u4cZms1Gq9UiQyiEdSc2YjJkrKWxR0QbrZSaO3dISPG9733nm9/8FgD7ftEY8yfgpolDPohnbtul1gdg3kjBQUKag0S8yTOk9MKw1dXV9aVbv/Sxj39MhXpyckpK4dr0KIaxxpvYGC09r6urAgx79+179dVXXli58vmVL2zZvHlsfDwIQmCWnudJT0gRPVBYN0HMZK07kdbKGON5srura3h4+Ljjjz/llDeccMKJ8w87TErZaDRarYCZEJGiUBWY7Z2waAcHQSilnD//sFWrX/jsZz+7ffv2gl80ZJwlQuyUl85sl9p+xHHy6IahM3pqzGUqKTwEHSwPelIGYWvp0mU//OFdp5xyysTEFBGh6zYBOPq2oI0hokq5Uij6+/fte+6Pz//ud79dvnz5zh27lNbFYrFYLNpFj8JJG1GSsSFPhNQJgYhCSCml50lEAQzEFIZh0AoAYXBwcNmypRdecMEbzzhj7tCQUqpWq2ujgdmaJjKG43NAzETUaDTmzJ7t+fK222974IEHPK/gRFMzxOIprNdumuIfkXP7cjcg9cWcrnS2NIltbj1js4QQgKBVeM17r/n6HXd0d3dPTU55nkfMZEy68W2iRMTEXd1dUoh169b9/L6f/+qXv9qydSsAVioV3y8AsDFaaWWUNqSjFxw0UEd7N4SUQnq+53kF3/el9MjoZrPJzENDQ2efddYVb75iyZIlWunp2jQAErG9o9YvGGOIGQBarVahUFi4aOG9P/nxbbffJoQnhIgPSodsmGew4B0thfVMKISEdqDYKXg4ebmNU7AdWrIvE0Iya2PMF7/4z5/97D806s1W0BIokiCHnKjFGFMul4vF4gurVn73u997+OHfTE1VS6VSsVAkIK1UGAbWmMyEKR3UGaYPIYTn+YVCsVgs+p4fKtVqtXp6ek4/7dSrrrrqlFNODcNwulq1IXVsxqL8wX7nMAyPOvrIP/zh2U996lPNZsv3C8aYvKvNhiHYAcTOZVHR75MoKI9aRpkyZzCnzDvG4WjscoXW2vf9737nO9ded221Om1fa+KNn+SrSim/4Pf29q5etfqOO+548KGHqtXpnt5ez/NUGARBS6nQ3WX5vRZ9VWyLnl0+QQdcERF9v1AslsrlMgLW6/VisXjBhRde/Y63L168uF6rt4LAbnBjTJxQR5lds9k67LBDd+3e+bGP3Tw+Pp645c4hKTNiJk5sOwpxDjUzFMFuqNkWZuUfUkqlwt7env/5759e9qZLJycyZoeiDJbtzejt7d27b++3v/3tH/zgromJyYGBAURsNht2y2dXHHMIY0cnhwjtxbUY4kzK0elzpPRKxVKpXPY8v9VqVsrlq6666uqrry6XK1NTUy7swTZnM0TMrVZraO7cVtj66Ec/smvXzoJf1MZgBzOfj2F4Zij0YGAcdjrh3OnMSymUUn19fff/+tfnnnfuxMSkJz1itqltggSEShWLxXK59NOf/uyLX/zi1q2v9fX1IWKr1QyCZtbUYAbr6pyUYFJMjL9Wzgxw23/YPSZCiHK50tXVzQRhGBxxxOJrr7329NPOmJycVFoj2rMLZIz1/AAQBMGcOXMA6YYbPrhnz56CXzJG/4lQ5QwpGyc3gHNfO1NA6XAzozcSQhqje3p6Hrj//nPPO3dyckpKyZRAM2izrVCpnp6eAyP7/+kfP/eTe+8tFkuVcqXVajSbDfc7xKYiczltxY7U8EWgNDNGn5Uc2fSi2WW2cL7EK4To6uru6ekNg9Dz/CuuuPwd73iH7/u1Wh0AtNZkDEVngS1y3tfXKyR+6EM37d+/19oifN24nNH5UO6QB7SbnfZ0l90CIturR2YuFgr333//RRdfNDVZlZ60QVxSMGdiZfRAf//jTzzxiU98Yv36DbNnz1ZK1evTSoXt0K77//g6ctFd+iAyACCEnNEJpyvPbcufPtf3/b6+gXKpUqtNL1my5GMfu3nu3KGJiQlE1NqGvABog1RuNhqz584mohtv/ODUVFUKaYyxRh87mkbH57YVwUEiisSjolP1xYOWHgAYUQiBWqt77vnxm6+8YmqqKj3JZO81JyEEAPT393/3u9/96EdvnpiY6O8fqDdqtdqUY3Ms8AwR+pkEv7YG0EYBi3YuCmI+7NBDu7q76/U6ouicMmKOXIXxe6dIHwIYomajTkzdPb0jB0aee+65Qw87ZNHCw2u1mkW57X2zSYgQolqdHhgYPOvsMx966KGkOpQJdzA5hZmraceY7Q3AnLnFmZEgjL+ElJ5Swf/75X+58UM3VKvTnvSi6gejDSC00VLKYqH4mVtu+edbby2XK57nVasTrVYjE7XHqJEtFkRr5mQqWYIMRumLlMaou+6669zzzvvFL+7zPD/C8uIviS6PBqM3jSFuTG68+x2DMAiCVndXdxiq5cv/0NPTfeyxS1qtlhBowQsbHgGA5/mjo6OHHHro0Ucf9ehjj8Sf3uEsu3QezGbR9spkfE0zFvDzWwiBETzphWHrQzfedNvtX6pWp6WQboUEEImoUCgQ0Ydv+sidd945a/YcpVS1OpGJc1LmYrLFs5eDHXJyAPQ8qVRwySWXfOHzXzjmmGOeeOKJ7du3+V6BmOLVzpFwHIpkdDPiTYeYFpQRjdGNRt33fU96K59/oVwunXDCsnqjAQAWq2Bi63WklAcOjJx+2mkEvHr1C75fsNk+tt0Hl6OU7PSkjiYRJQBjvBs6fnfsEHQGZ5z+xnv/+ydaGXYrcpHDMoVCgZhuuOHGn99339DcuY1GfXp6kojSIwSJIcDk+3cOezitDMSmg4vF8j333NPd3W20WXLccff+5CcMHBv63KbK3kV2Pj8ye9Ets6kpMzebDSFEd3fPiy++XCj6y5YtrU5VLT4BCAmO6vv+/n37L7zwgnVr1+7atdPzfGJOCvI5Hl7yJXKOKjJB2DHrQee4prVcwUy9vb0PPfzQnDmzW0EoEN0ilCHypGTga6+7/sEHHpw7Z+709FStPu3uCoGIiEKIxD7ERzN1BZ2CUkQA6XlKhZ/4609cd921IwdG6/X68ccfPzo2+txzK3zfJ2LXtuRiWgAEkSHMYVoLsiTx6NODIGDi7q7u1S++5Alx3HHH1Wt1G3RYSIqJiZmAatXapZde+rtHfh+0WhgnYBnzl0fxM+ZcJu4LszUszB6ixBtLKbUOv/XNb11yycXT1ZoliaQIe/ycG2+66Ze/+OXs2XOq1clGs+542/RvRAZBSM+DaOOgEypi2/+i22+MOvTQw77//e8FrdA+NQzDN5z8hp/+9Ke1Ws0aw2SnISJ2rI5GlBxJTETGxlGYHh1EgCAMDOlKueull1+eM2fOMcccVW/UEdAiRRwV4Lher3d1dx999FGPPfao7/mcNxzJibdxEbrbOjkBbjKZUKQwy9YEu/vCsPXOq99565dunapOSyndQooFhPv7+/7+05++664fzp07t1qdbDYbsduO3wbRHpolS5ZMT9fCsOV5Xs5ktrNo7UoKIbVR//EfXzn9tNOnpqakFMzQbLYGBwf6B/offvghz/PZhTESB4OZuyqElFIoFXqev2TJcaOjIwJFDBJz/AJUKmSm7q6eV15de8wxRw0NDU1P1yIcBtEW4TzfGx8bf8Mb3rBv377Nmzd5iStKa9qYFsBi+n6yy0WG8Z2sUCd4D4UwRg0NDf/rv/1b0AogTtQ5Lmwprfr7+r7+ta9/5zvfGZo7ND1dbTYbkDH50eaXnsfMV775yieffPzUU09VKjTGSN93bWEbtsVCyFC1Lrn4kve/732Tk5Oe5xERGSOlGJ+YeP/73n/eeeeHYUtIyW2cZtfnS8/TWoVhcNppp/3m4YdPPukkIhPzMNyIkRGxXq/VG9MA8L3v/WD//v3FUtHut8gnMxtDfsHfsGHjtddd19vbR6RF9El5LmDs+RM7F7Ojo1osO5+clMXTV6MQaIz50q23zp9/WL3esDg1xfB5qMKBgf7fP/r7f/qnz/X19jcatUajZuP7pD6ZLIJ98yeeeOr0009/9tlnv/GNbwwPD4dBExGllBkDjqm5ZqZisfSl224LghAFIqI1xIgoEJvN1j/+4z/5vm+LLe0AOzALKQEgDFuHHnrIV7/ylZ//7OdDc+c9/vgTNrCJ6yRpmGATwKmpyVazPjk5+aMf/ZetjNpEh5gB0N6IVrMpULzvmmuM0SiE5dMzZ7wXQ0qCTQosIssSRAbuyE6UUoZhcO65577/2vdPTVYt3kDMxBGCWyqW9uzZ87ef+n8QhdJhdXoqbwScbIOIEMWGDevXr99QKBQ++tGP/vGPK667/nqtlVKBlJ71z2nliMGTntbqwx/+8KmnnjpVrSIK5qhYwcxCiImJ8ZNOOum6667XWkkh08PEDAAiTlwA6KabbnrwwYcuu+zy3bt2/2HFH/ft3ytiz4FOdBS7LESA8YkxFLBt27aHHn64r6+XmaLtZ0sbxvi+v2P7jrPOOmfx4iO0Vvb620BQ6zkytl5EJp7dBgqnESAp4xD5fuG2L90GDFrrCGAmsgktMxeKhVs+c8uWLVtLpdLU1ISbiWY7KaIM2fO9qerks88uZ+ZGozF//vy7fvCDRx995I1vfGMYtrTWnufHMQUKKZUOFy1cdMtnPjMxNmFBY1tet/tRGyOEHB8d+6u/+qvh4UO00UIIjipU6HmeNipUrXPPOfeB+x/47D/849RkdfPmLZ5fWLd+vTHak17EKUq45ugm4MjMY2MjxWLxqaeefm3btp6eXq21ZYwRMzFoY5h5qjp9zTXXWGZNPgZKom17J+JfCsyuN3bqvpHS0zp85zvfefY5Z09OTgkpI/YTAwIqpfr7+3/yk3t/ft8vBwYGJqfGiQgRIYEHnGw2TesYAeAPy5fbBQrDsNlsXXTRRU888eTXvvb1oaG5YdgEYCmljU6IzBe+8IU5c+cGQQCWAcexEbCVBuAgCAb6B2655TNE2u5eKSUxh2FrwYIFd9zxjbvvvmd4+JD16zdobYrFghBi7auvxIyAOFJMuOtOLChQaK2npiYKfuHBBx7SRttaCqbcL5CePzIycszRxyxdukzpQKAA7MhOcdcBpRACOJMjc2oy2KbvzFQqlu78wfcH+gfCMIzgUiJLifU8/8CBAzd/7ONhqCzAiUlThbP6mDuSCEQUBuEHPvhB3/fJECKGQYCIZ5991tVXX12tVlevXm2MLpXKQdC86MKLb//y7eNj48ISmwGAgcjY4klcdcB6vX7qqaeuWLFi27bXyuVKEDSllB/+8Ie/+tWvHX/c0u3bt9drdU96zCAE1mr1737/u9PTU+gS69PcKXFh0XKEYdDVVZmamvY879hjj200GvHnMiIQsTHGGLPo8EVPPflkHNpm1p/jck1ytEQm/GSnmyu+FimlMfrd737XSSedNDVVtQunbSndGK10uVz6yle/umP7Dt+T9dp0WyMGdODtsnUDuH7D+ldfeVUIQcSIID2Pmaar0/OG5915551PPPnEeeef32zWhZC3f/l2FSqttTHGkiCSKq51RhTV0k29Xv/c5z4nhGg0ahdfdPEjjzzymU/fMjE2tWXLVmtatNZKKyHkhg2b9u7ZhSi4rR81A8EgJtt2ZOQAAy9fviIIg0qlQmxBSRv4sEQ5PjZ59NHHHn/8Uq1DgdgGbEImSSSQiCJhu2GW02L3LzP5vv+d73x7oH8wCEKMvQkCGkPdPV0rn1/5T5/7fKVSnpwa10Y7yQwm/8/fE0RmltIzRi874YTTTz89VEqgYLLJPGitg1Zw9FFHX3PNNYOzBs8797y3vfVt4xPjlkuSkOmIOSqXECWHoNFoLFywsKe35/LLL//c5z7vSW/Xrt3EDMDGRNVeo01Xd+Wxx554fuUKz/PiDDJJwjLnNQnfENGQRoBCoaS0WrRwweTUJIANiMhoHQSB1koIHBwceP75PwqUDkTYAWMGBC+moqUMLBdFtYTON1122YknnDg6OiqizIuAkZCJCQG+9e1vB0FIZIIgSPFFlzjD7VW1tK/qicef+NjHbsaY2xOl00IA8/jEpED8xF9/Qis9MjIqUCQLHf0ZkYFMQrlgZiHFnt17rrvueibetGmzrVtobbQxbIiByVhrQa+88kpnBiDablGGNoInopiuVfsHBlatXLN6xQZmC6N5FgcjQwQkuQB+IESKi3BS3koKc3FY6oHTkuv2kcafSAD4wRtuVNoYIkCMq12gjenp7n7mmWcfeeSx7u7KgQP72ztBXVTcibIj4MXWilc8t2J0dKy/ry8MQ4fkzNYoEdPIgVFjCBENUcwZIWvE4t2fVnBt5RkRd+3cxcwCURujdcw2MdZMMQKMHBhdt+5ViBhK6PBt4pSJU0OEaWuvjYhGe0t+2JwGwcgCQEQcerBZMEwGe4XgJOuJ3XumMdB+jpc4B+RM+YUBpBBKqRNOOOGSiy+qTk0JtLG/hWQjzv5dP/yRMabZ1CY2Pui2h3KeLpyUiCiqqYk9u3evfXXteeef22w2MU5Eok4ue0MQEcFQjIJxnHxHF+OSXdgY2whAkVekmORgn0+GiTWZcqm0du3G0bH9AgXn7D+2JYFpTzAwsEDZbDQbjc3tZVSOACUU0kMWcUcgIrdTA6K9GKXNLrEgBcNQAPA73v6OcqUrCMOYM8YAaMh0VSovvfzyM888Uy6Xp6O0C3Ntupxtr3KFBKIwUUgGXv6HFRZGjex6tPoJP8cYMvG/mIkgTUPS3W+MNUX2QUpp67GNiYITImO00cbYJGPtulcBWEjZ1uaAbelQ4hTiQh1KATL6EySCBJYAAqN/esjooOcijro7GDsR2+QOtAitVblcvvyKy6tTUwhgv4ONfbTWnifvu+8X9XrdchpiUG/m8g7miWHJxz711BPxqYKYEhKtqyFDhoAhpsURMSdMdG2ivpdofZO/kV16o7XWWtmn2xBKKaW1bjVbL7/8YtxAk2Ze7RwGa4ic9RPxukoBAlEKlAKFQCFQSpQCJYJAEIACQSCLBIpBJ/xP3t+bqeFRCKGUOuusc5Ycu2RsbMyaYGt5Gdj3/G3bdzzyyCOlUnF8YrT9AGMnbgbnKD8xZWj1qlV79+7rHxhQYWjtqA2HKGHTxV4huUPW88bZWHReDEXGxhjSWlszFd0Z66WBDZEUYmR0dPPmLdleewe5iQ9BCl8l2QADgIjZ4pjdV1lpEk4BBgCBwLFfR2RIgDcBufbqGLKz3UKXX/4mAMsMoKRLggyVK+Vnn332wIERZtZK2Vg2g2W6QgDY+YzZrEQKuW//vlWrVpVLRduykgT28VmIHULkdKM7EAehsZGKj4LRsRUyRkVWyBhLMg2V1trzvZ07dk/XpqSU2QJyPhPIFU8QBKJAQIESwe59D+2f4An0BfoCPAEeghT2BNh6FwoAgRm5i8hteJ1J74hK6VKpfM7Z50zXpuNuibRFKwzDRx59TEqv0ahC1lLmiRTckc2JEX+PWQphyDz++BOXX/7nQRDaCk9MoyNijjY6Mxljt4LjHIwxOr4B+YddfI4jB/tapVS5WF6zZg0AIRaYTKaZlmPwL+q+clL6TCkfLQE7/okQgIDS6e8hBraNJlEjDxKgQKaY4RmRprw8fdQGJxKVUsceu2zxEUdMV6ej94sjjULR37J588svr/F80Ww24tRhBk0ajMCsPK820ZBgBoDlK5YLKWbPmmW7vZIVtjfAkLGoa+Jj2f6KOQxDrXTUGWB0suetg7B/ptxIIq2053mvro0hIId2ZDdFeyE6x2pJarUxVioQpCc8KQpk2LBGi48ja9bEmtnE+knEaHuyYp5SlEHkxB/Yxj9w+umnFYvFcTXueZ7djJYLVSz2rFq1enqqaon19pRxtg04i0VwBx2b+JMsrrNxw4Z77/2pwIjSQmT7IaLwzYY3UfYemSJj917CpWWwHS+R4TdsgMB6bIrb7SzNDRn37NkFUT4PjgaYSLgwjm9Iq6iWT46RHxaRIQLpiWIr1AHo7pLfU+xm8qabtboKyrIgUWoICShugKPYD0RuxuvIWrQff+YbzwxaQdLRAnEgrrVetWo1CqzX6pDvxUzaFKLAOC2280yNnYyAk5Pj19hqBgKnLFT3fPLMrce5DB/d9u7Y/7Mt4DCwlB6TsauMiJ0CNLfHyAJ36Ai/gLARJ0tPFCUUqmHtlAUnvvWEdy0sLS35Ayx4ZHLb8t2/fWjDg9PNWtEvh9S07xdfIsWESUYpvHxPHyIRVcqlp595evbsua1WK8bpmImFELV67aabPrpr184D+/cYokzZqy0IZVcCJSk7OFTJuF+RYsrF/0EkJMP7fv0XRD2wIi3AdKLjJEQiTM2OsCdAgBToCSh6otAy6mMXfOgt8/+6fqBrahSMBGIQBANzoDGw5ktP/u3qnS9XPF9Bi9kQGGICIAbbmM+iUwKAzGbR4YcPDw1b8JnjypchUygUduzYcWBkxAYdAh0iW3uTt8NH5TTmdjOdBHAUiPJPUwyDjlw9J3Zsj+kynEYhpDXSTtbCnSlQ2J4+2bcUCF5RlBuh/uSFf/3e4Vu2rq3sPxAqUJp0aHTNqNf26db2ZbecetcRsxcpYok+gE0RstfTngfYAPS4JceVK5UwCKI4m8hEOaTcsmWLCoMgaEI7eSF15JxHlsAFXMHFizBmqSSgwf/lEacMKYjBcdHUeVh/7kqF5SwZ53dHxuhh5HWFh15NBRcdf/7b539i1cvak8bzPEBJRmgjFEmlxa7RYHTrITcc+0UUjOxjJBCXoQp4nXohEQCWHLfElnuMiNIi6xyVCjdv3iKEUGE4k2xFTqLKskUjiDFptHEMuRBS6/Cyy970N3/zSaWU7/vMrLUmbUCgFDLiFyOgbXiyKVlcEE5KWhFb3RiOlTiN0URRWQkQtNa+X/j6177+1FNPCulb4ZVsx2F8oDlp40LIitIgIIIEEITNd57wnv27UZbYaIkCiFgTaIOB5pYGw96+uh72Ljppzpkv7FvueTIWQcJEjNDrwPlnBoDDFy0KQwUAFku0RXAArNUau3bvllKEYdguqokuvyst8iSc/XaefMLDgSVLjr300kvtr5qNVhiEHMlLRLVHIgdSJrYZly0PWJzNRCUaSoi0TKyUagUBMBTLJSHErMHZQ8OHZIWG2vR4XJJ+yulI2QUIqDQdNjA8HJ68bwxQCmWYDTCBImhpaCpsaVDERDQ66R1Vufh5eBKh2M738XINBXbXCyHmzZvXbLUQkCKuuWYGgdhoNMbHJ6x0j7DJCLYR75LmIEy48ZzUoTGhZiTFAWYAeOnFl++445uzZg0evujwww49tH+gP1RqamoyUT0x2q5phDlHBTBtbLrAMT4RJ9Fkn10qlgqFwuTk5OYtW3bs3Dk9Xdu0cVOcmmQFArNgpbv12WH1IDAiGIZDe4/Qjf7pGpe6wBgwBgyB1tA03DIQaAgVKA1kwPMWSCE4J5Ziw1BOWiDinUxkuru6Z82aFbRaiXSGDa2LpeJ0bbpRb2itmDmpuses9KykIULqFtnd8tHnJXedDCGKp595+vnnXyCmvt7eRQsXnXn2mW9/29tOPvmkqalqEAbAUQ8s2UICkYijTFZkcUUEREYiK8rBnicrXb2vvbb1qSefXrVq9bZt26ZrNSJutWpxpJ8lErrNNbkGu7b2CwKS6BsSgWYO0RgIDSu77hpC4sBAqEgpwxqaBSFsH0bSTxkL7nmOBmySg9DA4GBvb28YhMZQbEeYmQSK8bHxMAxta0rO8c6oupWRhUurPxx9XKSiRWSkhyW/zACvbd++YeOm/773v6+++h1/+6lPSSFDFUYiuRypZMVQENuu46QPluKajNb07W9/56GHflOr1Xzfl1KUSyWlVRCg08qXoAuc08XFDEcB45OQHBDaN72zZZpGdNUDCu26GwgMh5qVYW1BEjaSynvNToJAQikbJRIAeLlrsVauv7+nUukaa47Z+qO9CCspMDI6ak94e0MUt3U4clTMxph9zJl4jzMaVcwwNTUJAJ70SqVSqVRWSt3xjW+sX7v+jm/c4Re8lI/EzIBEbj0AYt0BBgaBSMyf/8LnV6x4rr+vz5PYbE4n3a8CZTZ7ZEcuO9dqyY6eYMrfJIaClLsmt+1urJfylPEqKS0UsWJSREqbkLShkCwdD0vbzePMxFEuxuAk3AI6fDQMDAx6nheZVjLEUSWEmWvT04gQRu1dmGceZYpHmXJq+vx80sPJ7rNbURtdq9dGx0ZGRvdXyqXfPfL7n9x778DAYNxyDGmEaWVV2OmvZiJjKl2V//zR3SufX9nVVR6fGJmqTgRBKxY9EeC24GRwdIaEQ+CQUxy/xgzMSAwEiKExj+6+22ecqKlGaOqhroeqEYZNHTRNrWlqTTPJLMb5uf3mSU+UCbRNZ2OLzGATMc4QSBAAenp6hJBWk8oWsLXWFp0Jlbbtg/mECjunpwyOwKjDOs10LaZGENntIWGuTleFhPvuu+/AgREpvUgqkTje7GxL4RmqrO/t2bvv0UcfI9bV6mS2eShfIspSFdANPTm+IustUqajNXKsyl7l6T2/WBf8ek6lMq0aTd1s6VZLN1tUD6jR4jqCYKy+ZD5vILBJCAPFOkjR8RcIHdo4rdKg0cYtdttLtlvJGJNU6WLhI7f9BLMt/OyywvLSDglX22k/dbcFGfPSyy+uXPlCV6WilLLYc1SQMbmSLxljfN9/9ZVXDhzYo1ToZHxxl5hjcjpISnKKjnSSFohUtwgMgyYIAeCn+z61v/irQ3r7gbGhqw0z3dI1IurmYQ9bL/AnxmClgAKxij+AODW+LByiDjhtmwUmStLSqAWD2GgVBGGuRuRq1EfACXPaTRR7uFxzr/uF0Q390m6liLOKQhCZtWtflZ6ntU6vyJV2iKrvpJQCwD179liGLLsALeaCBka3FIaZLRgdAkejGxITZO8BG80Bg27p+j27b3y29ddUXNlfCmdXunsKnif37sM7n+Z37qPHJZQNBwSGwDAQY2YbeolSnNuMnQQvSXUcIhIkSyljJlOMoyUnNqf2m4OnO6kcpA0RMSsmJSal9gABYHRsxNK5MktuJTWYmSGuAGul9MTEZAYNhcTViURyjTtJuFlnGDN50uuOYzzCCLwhiokhQgjB8vnqf67Gu/u8Q0tidtNM1Wi3gmkBBQFFw0GkVgecR8XcmjA7GjXxFiMmTARRbeZSLBZF2pSL2Q5X19BgdnbATEAac7Ya61Zi3cjPMkqiAn1qethW4u0tsYUCANZGZxgCnPQfdQAOM9AMJzYVU/lCZ6twhPkliQ0ZRgD0scDAY2o78RYBILAooYtAMyhIuweZMyeO03oApkEiA0CoQlvbsJbHVYG0dVSb4WLnOR2xFXeY2JxvXebO0ibYlks7AoMRPwU4QhnisqStfVmDiZmxAi7VvF1RKa7LuQFmZD45FTqIBd3jjpUEXze2NcReOoGO+s7At/pfhLFWXbro7NQ5onf3cpQp+3Slwjj8TyUN7bcsFAqe7yGKDrKhDucx6b1PYyXnhLkQUIyA52oHdhaCU1pmMLHAG8Uu2FYZTeqHU62lDLMEM1VriNPg/N53tbuTnY9xRo/QJpvHDJwV/s6gMZn6RJTzsTuYB9OKWCJhzQAA1WpVG2VBRlsHiJSDibq6KqVSMVV/y7VyR00OtqiVeAdOW8RyKhwWxEjY4PHpjFxSqogSmZJYPiamWjFpFUFynAiaaU2G2qjImBcEsQaOGfOzhKLALUuXS2tkeSUid4pMWm3iKAiJ1xQzOGS6eF62kBR9xvj4eBiElolgVU9jSUPT19tbKBQ9zwOgaEuzAyalc3US35sxpFnpzHRwQirtn0ar0WyEpK0sijQRjUkoEcbSxCxJP/l5etAddWG32T6Rm3IMY0rUyBlDt06QkUp3Q3hMExyOJ5tgir3bwNZVvoxe5uV8pEXfpqamms2GlaKBZPmJlAqLpWKxWPI8H7I204GEMIqj3Z9yJ7EKdMauOHxp7Cy7AZZ7IoQgY5SKJOTiRY+sktJKKe3YuTQ4c1YSsaMoQOLxM+chI9WS1pgjC0tuEusJkVixtKZgKWiRTU9uZQQ+eFk0P9pzExOT09O1YrEUhmHSi2qIQOlKpau3t7dS6XKF0jhVmIM2da02IZdOi4tJ3NGmcJrYZSuPy8RaxwwhTo8CM+nkNHAq0cGdlLQwC45wLjBOIoM4ZE22NMbWNDL/kS1jBGE40GrGMR9CFLLyUpFL97KmD636W7PZHB0bXbhgUUIGsamV1qZULPb39ZbLldxWiZtv2iryyNxWp+WO+UDUHR7Z/7gEFvlju9mtaDfFypKGyGgTKsuniwlczImCUA7twcgQuDPVcpJjTkqSSGmnVjChNsTGKmZEE6te79Azl55cKfpBqKwlNsYYoyRyIwxXbF5pKMS2aqAXO6L0gwUKArNnz+4jFh9hjLFxp0W8jNaFgt8/0N9VKSdwUqajxtFp4xQQxTaYKD2gmW4UbpPey8ozGaOFkByF/xFPIEnLIArVNGZUkzIaVJhkWB1Q/jSMcDSXEFyaUAzoxrVV+/VNkee874jfXf3mY198LmBSjGDIhCpkNgW/uH/stT/QhYDETi3arruXRKacSq8hAGzevOWCCy6KWLGJ0yMCgNmzZvX29nmeZ+HFnKByXt4wNzMlu+1S2CtpkmLEVEs5zQTSsSWcOF+bg6VZmE0RrFfIt3mBI2rGnE0WkDsOLkzVDTn1t22TNBDRoOrmY4Z6j3r8mbEHHztQFsoQK2gZaDBoD2ZrWGfkNEIho/OINgx1Z9U5idrWLVsFiqgYFsd5wGyMHhgY6OruKZXKtVpNSi8pLTmKLE58zIn3x05QRPxdcyET5wEyAOuENaKwHlhrbd2y1sZWLezS259n9fpEUh5tZ5K5PIHENLNbYkWAg6mwIgN0i8W9Fbl1rNolGoUya9I+BMSaQRVRjcImCthDwaCdDi1sZ2ekhdrNmze1Wk0TRXUc98VBs9nq7u4Z6O/v7e3rNKGO3Y2CCcIVucMZhJTdiIRdvRnO0sXilgCjk9UnYzjpwCCjldZKt1PlmTHD8+FOtM90QR0aTWdVyqymBcOQd/qsQ2F0VBkIAl0LTDUwDUVakTEcjquX48zXVQ3hCA3N5u4Rw2PHjh2joyO+71tWhNUlNMYEraBULg4ND82ZMzdXhIH2oWEJpp4OP+V2/Bdd0DEPUabxkG2P1XHnC5FDRacYitNapzKMmVETzmHqVMPj9oksnHS1AXemVgICg0bjLxw8jYs8MqbRDzQ3DDcMB4ZDZkKkOm+xUVxaE4lTWNH+dS17stFsbN68ubu7OwK7tI6o3swC5ezZs2bNmh132ELm27FD4chIdSFwO3uurauDMQPHO2cj5jtrQybh/SerrrRSSpkErc6+pVN3w2zPaBowZAZGtnVsdchTEBCEQd2DxxwxtGTn7pGJ1hhhYNgQE7NiCBi0gbE67wBEWwnglBeEDCzs1eUOoiXHrVq9qlwuMdgKEFkkEgUarWcNDvb19fX09BJRpickU/7qeHYxVwvLcZIgUctocxk6MvdstI7QNxPF/lorpbS9IRwJo2VxHm7XBWPoJOaUPSjOXF/O11oTmzEPL1g0v/zazn0ENUPasF0pYFYCYIrWtXhSgHQYPEn6xCLpYXEH7doo4vk/Ph+EClLmmS2AcLPVGhgcOPSQQ+bOnRtpw2CGnp7hQ3DbF85b/bZBh9jJCcddIsYygYzRtg8vrgFobbl0OhKljyO7PF0MZx6Lw/lCXUeLk4EfmYFhUemSQh/v2Bn4EgwbBsWoGQwDSCyM0fMJ49/F/dA1QfkrYUbEjZs27tu71/d9QwaQbSpkjNZKSSEXLVq4aOFCl2DjIEAYG7l0klRuSHFncnP7bXEqWRRZfWIia3NiwQSK+2E0M9scGXLGBnGG1rWDsa6xQ90gU1ImCLvoiCWHnD8yPT5abUiPmA2DATY2oJaSqvRKuhnaMGThbjI3r5XCC4Jg9epVPb29RkWwS9TFLmWr1RoYHJw/f2F//0Ay9NGJXDJzCDCFZTg/75NnGJrlIjNJuG2RhrT7xWitKF79eHyGVmHISel75tm+eWW3jPgwd2g/6HAeBCMt9K485tj+Ddv2GKgbVgwm/i7kYTGAvdO0DVEkqJG7ExlAQBtH23VDTzz5RKlUtBknc9IdR2EQViqV4eHh+fMXWOaoe9mZrCKlTkSkh/y8zBk9Qp7lZZc4VEopHQPPRmlle1ZtkBqGSkeEgUyLTnufJrrAWIfILNtJ2wkpZCbB3pK+txcGw02bxn2pNUUZCYIA4KLomaSXiTWClx1pnFZdRcZ6ZGkAiPjCCyv37t3r+761/sYYrZW1s2zMIYfMW7RosSc9jgSCALOhDWK+MxY5Htk9U8dMTP1xG6cTE2TDfGv0bRSklLK9lXYalYm1/zvdTXRLRzlj7layXbUg7jitzsY/EA6Jc0896oxt+3dONGtCEMRtFwiAIBH5gH7aUrmyGxudFJHbGhFiNyCl12g0lv9h+UB/fxgGtjeOyCacPD093dfXd9RRR82fv8CQTpqebMic1X3D9hh7Rn3kWDI6Q+wCEAKV0qFSkVhOmgNoxxUrE7VrU9Z6JFyNGTxqfmq9k0GCKyTnEsgRkJdUPjB/if/ymjGJhtgwUyx7Tj5WFOycMusQhFtJQ8zMdRcdW3NicQkCgN/85mHpCWMMYNIebbee1tosWrjwuOOWohAxo8ApPyN0GBOPMGMnd06sBzPGyer8hLFkkFU/sZ3ZSf5lm4FJG8SOrckzzqrFlDyPDhqQem524jkGECAMBD1w5BlHvmUkGNm5p1aQTMlUEkBA8kV5r3mcwCBKF/7JBr8oIHOvIYs+shBizZo169at6+vrtzF4JMpCJKRo1Ov9fT1Lly49dN4hxihH9JGdpJjz88fQFZid4WZg3jzHaKAJQ2XVB5RSST3Srn/SL+8W/hmdopWrJ+nkAey2+mCKJMYycjnFHUD0GGipf8OyE7uff34XQJjMc0EEFCzBZ6jv0Y9EjZ0d2oSSKCjlqmRC8WTMBADc/8AD/f19SoUJp87Gg0qrZitYvHjxSSedjJlvhJBRH3RAk2wJHADg4IPOnFMftwGnDcBKqagROJUqMKFKa8IZPnmWqZqINySKWJnrcpgs+d2JwkDQBQvOWXzDNFc3bqqXfGKKjKdAAUBF0T3Oy1s0IqwgEGZLQ5wNQ91wjDPhvGXu4+OPPXbgwIFKpWJbpy0OxkRSiFqtUSoXTzr5lEMOPUybSK4xTffSBXcy+uyt/hNbIK1sXhAGNu5MXa5tljeGmJRSKlTG6DbgMt+ZlbvrjGmQDHlRn3YjKgj1Sd1/d+Lps55cvpmwSbHdsd1LEgoeyp36lx3VMjg70l7kPsDhkUQ3TQrZCloPPPjA4MBgq9VKm44E2sy0Pl07fOHCM888y6pvxrJQUfmP87kWH2SbtznD9LeGonJj5HVNCslFe18bE/2U8qq7eSTTRfcj7m3SaZmV+s+yCIARhebmoFl6xXHXj8P+tRvHip5tQ0sQfi7BrCq/OmU2W0uV8attcYiYMQVktoQRYkLE++//9eTUZLFU5DjGs2AMAkxVq8R0ztlnL1u6TBslUMYujTEP8zo0hzj2y1SAM6uV2X0RBZ3Jgg522aNwKAoKlEXOlVK5hAQ7A+AYE37iuRDtGyHP3kZgEALP7f/ykSdXHnt0jyecQcbAAiWCV5CFberulCqLnXnAkAi3ZnyR0+8SCR0zCCFqtdovf/mL4eHhIGhFrSmxWhuiGB+fGB4euuKKK7q7egzphPuR+NIU/chqOOUxxwxklgmYUKBSWoUqwaPdjW+cuDSZFIouQogd8LZo53OGP5bemDbwR6CvobWIr77i/MvX7du+bWe16EWyAALRwm1F7J+g5aPmJYGSo4ESuQklmW0p2rtc2qQ2wDbI33//rw/s318qlylqhCP75YHZaD0yMnryG0658sqriIyrGQ45xcAEOcVc/YBn2HLp/dBKhWGotY4LMjYZ1korneTGxkB25gy2g2iZT2PInTrmHBgd7WOUBKoi5l1yyG3FQ+uP/XasyydmESlFx/o0noCN6s603ortX4/dLmrhAhGYL69gkjkgYqjUj+7+0dDQUBAEcZ9icghwfGy8Xpu+8sqrjj9umTZKSsFZ3YYstJnGgwwY8wQ5VxZ1Y7NYuomiYhhFReFYIsia/kibMosCZQMMjtXLOcd/ww6waArjIrIgEZ7b9W8X/vnhjzy+tdloyIhIglY0i4HKom+EfjdFGxGkHboO2cEZmJlrA5gmYu07L83fo8G/Qohnnn3m5Zdf7O/vD8PQiovb+E/pEIXYunUrAHz4po8MDgxqrYQDwObL2TEByZYK02ag2Dui29fqlO9NHPLbypjRJgJIDcXGh7RWdii803GRzX+xQ8NMdDu4k+YUsICCEvXF6i/fcvZf7qrvX7+2WSkyURL5AIKQUBYi3KzuzJoczIFNnMEtIzg6A3pg/uS6eqv4/e9/v6enJxndAFF3nIVizIYN64886ogPf/ijCCJX74qTHcxicDGXEfPj0p0BEgDxXHStFNlDoBSlVA1KNLaYGCNR544QTywpgdCurp0L+ZP5SwJ9xfXZuOzdx3+z95jawz+rVgoYT+zxkCWCAKZeOW+HvqfBBwRKN+VGlwiA8WmOP06kqLErLhl5bwanYc0mxrv37P7Zz346b968ZquZxCZWixABmo3miy+++GeXXnr9Bz6gdSiEzKpBxQRLnkFvJoM1Zt01x2LdqXhlrFMZN0sSWYBEtxeAMNanmHk4UU6zL0ErJbH2sPzmOXed9Zb+X/58v1INEdFlUAAKkAJlRc5pwMtb1D0IEoDa0A+OTh5nUVG3JuzyoJCTuqw7QQcNGSHEr371i61bt8yePVtrnQy0ISJtjJBydHRs7dpXP3D9B9502Z8rFUgpU6pWKmCTZYt2WHX3B9EJsC/TWlsWus2JU0woltIKWq1iqZhDGDM9y/HVMGblJNk969GMHwAEqS7p+sGbrzzl4d/u3reDSwVgg4gepuo1hRIWXwr/mUCnY0IQM5x9dirnjiKpYHYcNqZ4VMYcppWKqHfnW9/+pudJjoTk2Obg1kP6vrdl09Z169b+3d/9/RvfeGaoAs/zHIkCh9+ayUtSb9ux72D27DnT1RqRicEH0kZrpchEamY66uSkZtCcd9iwEJ6regXoqHHkGxoS1NzRb2JAFAKk4vq5pX+96b3vXLNz3+qV05ViYLQN8D1EX4APQN1izkbzlUlaL9DrKLYSJwvQ7pNE2oCSkCDzqjvOuLVYZerAgQN33fWD4eF5SikRy+zZL2LJyatWvbh3795bb/3ysqUnhGFLSg8TWZNEUiU/HhxjgU50nA4ykSflUUcetW3bNmBMxeMSFIgjUVEiwwD1Wn3RooXzhoeJje3TczjYmUA7EnJpKxjE3H4ZYu204qev//NPbq+PP/kQ9RSFMYlOHAqQCNglDqnC8o3qLhv5JNPJOI+8tR95hkwiltuIbV11yeGyjUp/fP6PTz/z1LxD5jWbDdvJhHETnTGm4PtPPvnUvr17vvWtb5988inxqKQMVypF6PJ3IgbgEYvFoiHz1re+DYUcGxsFYGWUIbJFGIqneES+mG0rA02MT1xzzfuYSKCwChPcufwTU/k506kpAAX4IddO8T75ybffNt098csfNSuFkEhYuSwEgYwC2ONuDyZXhZ9t4x/n+FFuj3zGzUuBIiUBOMMzMT/bykVqgZmkFGvWrFl8+OLBwVn1Rj2eKmODcbT9lNu2b5sze/Z73/veV19du237a75fiFpHOiOfmIQdQkghpNZa6/Ccc87920996oEHHhJC2vnySZskuEpMJhoe5fv+rt17zj3vnOHhoeef/yORKfildEISzlCATkcdSgBUXDuj9Pd/8/Z/afXV7/u+KvraBlrJNEQb5HXJygr9wUnaKEBmxB6c9Ard6XR5dgzbG5AvP83E2nN7G+wReeWVNaefdnq50mW1taxgDwAQMyD7fmHTpk3lcumDH7xh+44dGzas86TvuntOwev4+BMbsm5WDw4O3njjjR+68abf/va3U1NVBoib8dgVx7K89ERMgAE86a1+8cWLLrzogvPP37t33959ewwpW9cWneauRiRoQAEeA2luXNj7pU+9+wuTpfrPv2MKnk4xO2BEEIAMpk8OvUK37DS/FeAxUjqj1bkDmJVkx7aZhfEAh5lrI5lqBGIiS83MAoVSasOG9WeccYZNjpg50vOMWM7ked6WLVvq9dpHPvIRIeSKFcuZ2PO9aP4LOgpVyMzc09t71FFHnn322e9+97uvvfa6gYHZD9z/YL1eF0JE+qCGOGbkxBpBlIyBTFr7EcVLL748ODjrHe942znnnD1nzpxisUBkmo0AMkM+E9U+lFDQ0EAqvHXenR9/182bRhoP342lgmKkhDSMwAKB2fR487aar72qvinAYzBpJ2abeCGDOxY2R3dBlNJjp+znzgHkDHc7CVcT+i1baJCIDjv0sGuvvT4MQ6WUVa6K5MQArFRss96Yv2D+e977nmeefuZTf/s31epUoVCKeC4Og5/J/Mu//uuihYvqjcbIgZEN6zdNTk2USyVn8EUc9EOsaRw380cFjLipVgjhe14rCASKBfPnzxkamjWrX0Lx1ltvG586EE1gTCNOKVAGPN1Px7z/+LvfcsVpT61orHxSViqhzbIZlFUoADYEQbect4fvfja8GUHGoqxuSyAmyp1uRyYD5li04EzUzojetitrYbaFM4PBCkFECxcufP/7rq/Va2EQJL46EdoWQjRbzUq58u53v0t68tOf/vtnn31GCM/zvHSyM7OQ4rbbbt+7Z7+dRmA1koMg1MYSDiFulOfYC3DaKm9nicRDUKwrkZ5EhlazpZQxbBbPP/nBh3+6b3SrJwsJm0aAR6C0CY4pvvvmS//9yKPnPfxAc8cGr9ytoj4oJmJDaBDIQFAWc0fo50+p6+O+Ic4qnXSK3tvTbYznxgnhZVqlO1mhdqZhjNXk78G73vXeer2mlUIhEqnLSKRbCqVUtTp9wYUXvOlNl/34x/d8+ctfbjYbvl+M34sQYdmyExNYLRZMi7pf4jFccZoYbSwpQDBJAT4bwYwCJLKHIAT4AGib/X2s+F4ZBa3Z/UBL1aQoAIIFkJWuF2H4qkWfu+ZNN020zO/v02FdFkpG2RozWKatYTAEqiLm7qX7nlXvN6AyncedhmLPJDXrtkyjFF6Go5R9AWa1IzIdzcyOJnR0Dw6Zd8g73vFOALDjMGzgbweQRIaboDpdnT9//nve8+5Qqdtvv+2BB+4HAN8vAKDWKuZw///xsPQ09GQB0ROIAdXA4LKe99x86a2LD1u4/Lnmuhe8QgEBLL9ZW8lhsvPBIewSQ7v5R0+HNxBoa5vRnQOf6ZbGjjcAMZOOIcZOGGYOfjDPGkIXqceUcMVCiOp0deOmDccec2y5XKk3ooldycus7HGpXJquVp988ikp5M03f+z0M07ftGnzvn17iYzneVJG022FcAY9/68fuVcmA4ylRF8IqbmpdbjAP+/G075981v+Tqv+3/4y3L/dL3cBk202jArEAhCBEKFLzN5svvqs+giDQRAMkWi2m0Vmxna16Y5ijpJknyWEdPXc2GkWT1vcsgrozmFxVQ8j10dEpVLpL676i3nzDpuamhRSMnGsy0paa0AQiMxcnZ7u7+u96KKLlxy75PmVf7zzzu+/+NKL9k3swCTKnoZ2U3kwFZD0q0Rq8wiSQREbAJjnnfqWpR+/6sz3NELvuWeC/dtlsYQMYCVHIxpm1N2rBfseiBf0379i/j2TSjoaFC5s3laChjbPyu4N8MA1NdxBgoA7dEi5NS92CECp9PhFF17yhpPfMDk1GYZKejKC7K1xRyRiIZCYqlPVru6eiy68YNmypStXrvzP//zPF1atTD4pxb0d2rbDNJqRXhRpFVk9DTQxWahrSe8lbz35+jccfimr8iuvqB2bwBPCK4IxTPH8U6vJxMxE2sdSk/c/E96wkx6IyixxbuUE0BjrcjhmCDPSnB07IeyQWgn58KjDJIC4VZDjuDTtHXRXJ4ZSIut//PFLzz/vQmNMo9kQAo0hq28QCw0BAhviMAxbzWZfX9+pp506/7D5+/fve+6555YvX771tS0OaCWEFKkGBjG7Bb6k15UBUQohCAyxSYDhQTz+9AVvvuDYdx2/8OTpGry0yozuJk9K3wOj7UFjy22IhiQaApRlFLuCZx9T10/DJgGSwLhjTaCTYHnHUcxZN8rOVFvErIQgux3WMzHXuO2vTl2Vk79b6cKBgYGLL75k3vChU9VJrbRAwQhkKG6eJG2MzSe0MbVaTaBYvPjwpcuWDg4Mjo+Pr1u/9sXVL65bt3Z0bLQtQ3RTyKRdOT0uAmbN7zrxxPnnnTj/nKWLTodWz64tsG2bqk5A0Rd+EREgbm91GMMIDOSTr0i/qP51pfocQRivvsM2y6IaM4WO3F4YcBUUMDoBOX4/5yR9MSPs2oFoG83LitSMUp0W6xIA4JQ3nLJs2UmIEASBzc4QEYBsSTGW7WBEYYxROtTaFIvFoeHhBfPnDw8NFQp+o9Hcu2/vnt27D+wfGRkZWbtuzdT0tEARa/1HivTM5sj+i887+i8On3fMnMpRff5h1PL27YU9e2l8v2EjSkWUkq1BQgQgMImWNzOTkVAoebArWPVk6xP7+WnLxGKgNq17zII/nT0SdwzmXfwrvgGJ0HDmNZgwRRiyw044V75yzg67lZVEsqWvr/+NZ5w5f8GCZqMRhkpKAYhKKTKUzGaNJcUAAJXWQRAEQUsK0dffP2vWrLlz5/T395fLlTlz5n79K99c/tzjUiaQBjCDlFLr8KYz7rn0uPds2gITIzAxops1AsBiUfh+nLAyOyKINt0AApLSqwBWG5N/VP/+kvk3goYASUDgTqRO66aYBxI5v7o8U2+NKweQZMKd2qd4hsEX0KaokfkxJ+y5+FfJUVgwf8Fxxy2dO3eIiFpByyazEM3YtiPK41mdTrugiboCdBiGWpu+voGtm3Zu2fayEJ776QKlNuFfLrmjd99NIxNhpcvzfZAoIJI2BgRGkUJigpGBGY1gWSCphNkQ3Lui8cUqbED7e6CMMmEHOa42TeCOMRm7MhqZM+GB28GbnQSTn4bLHVUVsF2BHNNqdJRxRyOeAXbs3LFz584jjjxq2dJllUpXEARkGQwcaQSSYceRsLFGjVlKTwpZLJaITHd3ly02Y6cYgwyUS16xrDzJTGAi/SggO2SQIPYdTGA8KBSEVAbWNP9ntfr3UX4OwGbIFFdXnOpNh0aKvGwzdjTRmK8BxoiCq5aSVGudRhpOBq3MFH4jt7XacU6XzE0WbCFs8+aNW7duXrhw0ZFHHj1rcJbWutVqWVQngbWS2DaZgQQR0G2s20gqN7mTjhJZgFIskaVAAEoxGkIWTGwEiqLwfIBGWH+59esXg28eoGcgHqxmox3MMLxyc9JgJgiZISfO5kQ9ba2I4AzxcbDBLEEDsZ3P0wGtSMtujG25EHKmWSCC6l57betrr20dHp634LAFs2bPKZZKlnboak9ZXfqMIhtDit8BtI0gBWY0FFE/iNA6akAmYMHSZ983QAijtGFj62frgv+ahvXJ0sdcWnRaM9pLOEnHQSfLEweQKc8EM04z0wcG6Lkzh5L+puxoIpwZXcKcJ3Ch7HRcDEZJSuqd4ziVmfft27tv395yuTxv3qGHzDtkYHDQ932tos7rCB535u5oIhWqiFmD2UPACAAmJK0YBDNoQ8AgEQse+D4CCpjSO7er32+nX+2mRw3UOyx9+jU6QfuY0fbFLIfa3bD5YcQZcCjqULGCTdnzO2MLMx7kRznFGnd4cZ6S5EiWUGKUAJrN5tatm7du3dzd1T1nzpxZs+b09vYVSyURkeDT6arGeonOZ5IBAKVEDwUXfChKAaxB0/Qkr9kLy3fzw/tphYLxOFGQVgY3w76LQx7Of1Xs0FgwQ9Q/AwiarYdDNMoQ21RkmV2KWltnHXe6JdypxMuM7hQ3l38ZE5jTv9hdUavXavXaa9tek1L2dPf09vX19vR29/SWy2WBSAy+9Lu6umyJP0GIMOlPA5AkPaA6bRtXr03BphHz/AS/MM0bGeJ+ZpAYqd+ajH1Pnayr5JQE0gzYJtjnuru2Nm5uH9eSh+g4CUNnsmOvE6FiNuLtqEaWHSHNbRlcjo2G7vlInZXnFQrFgl/wfb9S6arXm2Pj+xM8Mg3j2Mz2jze6VOOtIY9nV0TGpobbXCvmerPQ+WJuR1t7ctuhypWpf7WFJplVTStiqU6ws954kE79LI/P7nbmmaLhVA4JMdNOzy6yhp3WJtsrlD6k8Dr2A1u8Mz5wwm2GgUwTZh5qSQRC2/pm821tWVxhhsqXq/XK0URzpzIc++Q4l2l/k45QErbbsxlC4OxtS4VBc+UfzlauISv333bek+F2PAMPh+PB0Jmd3iFxxaRZBN2xQu0ich2+c2dlktdHIvITXRhQusql7X37nU7bTE/IxL3t2ygb0Sb5m0COU1PhMnRev4EvQYPTkZHpNFJXcyYlisRc8tys8pidge2uD2cuquQKVO0xv3O0XWwzUkiMlun/A2eUsrLENshdAAAAAElFTkSuQmCC";
function Brand({ small }) {
  return (
    <div className="flex items-center gap-3">
      <img src={LOGO_SRC} alt="ImpactOS"
        className="rounded-full object-cover shrink-0 border border-white/15"
        style={{width:small?"44px":"52px",height:small?"44px":"52px"}} />
      <div className="leading-tight">
        <div className="text-[#F4F4F1]" style={{fontFamily:SERIF,fontSize:small?"20px":"24px",fontWeight:800,letterSpacing:"-0.01em"}}>
          Impact<span style={{color:RP.accent}}>OS</span>
        </div>
        <div className="text-[10px] tracking-[0.2em] text-[#717680] font-semibold uppercase">Impact Enterprises</div>
      </div>
    </div>
  );
}

// Deja solo los últimos 10 dígitos del número (para llamada y SMS — usan la región local)
const soloDigitos = (n) => {
  let d = (n||"").replace(/[^0-9]/g,"");
  if (d.length>10) d = d.slice(-10);   // últimos 10 dígitos
  return d;
};
// Para WhatsApp: SIEMPRE con código de país. EE.UU./Canadá = "1" + 10 dígitos.
// (WhatsApp rechaza números sin código de país)
const waDigitos = (n) => {
  let d = (n||"").replace(/[^0-9]/g,"");
  if (d.length===10) d = "1"+d;            // 10 díg → agrega el 1 de USA
  else if (d.length>10) d = d.slice(-11);  // si trae más, toma los últimos 11 (1 + 10)
  if (d.length===11 && d[0]!=="1") d = "1"+d.slice(-10); // asegura prefijo 1
  return d;
};
const telLink = (n) => "tel:" + soloDigitos(n);
// WhatsApp — con código de país (1 para USA)
const waLink = (n) => "https://wa.me/" + waDigitos(n);
// SMS — solo los últimos 10 dígitos (región local)
const smsLink = (n) => "sms:" + soloDigitos(n);
// Número solo con dígitos (últimos 10)
const intlNum = (n) => soloDigitos(n);

// ═══════════════════════════════════════════════════════════════
// SISTEMA DE BÚSQUEDA GLOBAL — usado por TODAS las listas de clientes
// ═══════════════════════════════════════════════════════════════
// Normaliza texto: minúsculas + sin acentos + sin espacios extra.
// Así "Bogotá", "BOGOTA" y "  bogota " se vuelven todos "bogota".
function normTexto(t){
  return (t||"").toString()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"") // quita acentos/tildes
    .toLowerCase().trim().replace(/\s+/g," ");
}
// Estados de EE.UU. (nombre y abreviatura) para limpiar la ciudad: "Dallas, Texas",
// "Dallas TX" y "DALLAS" deben caer todos en la misma zona.
const ESTADOS_US = new Set(["al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia","ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt","va","wa","wv","wi","wy","dc","alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware","florida","georgia","hawaii","idaho","illinois","indiana","iowa","kansas","kentucky","louisiana","maine","maryland","massachusetts","michigan","minnesota","mississippi","missouri","montana","nebraska","nevada","new hampshire","new jersey","new mexico","nuevo mexico","new york","nueva york","north carolina","north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island","south carolina","south dakota","tennessee","texas","tejas","utah","vermont","virginia","washington","west virginia","wisconsin","wyoming","puerto rico"]);
function limpiaCiudad(crudo){
  let t = (crudo||"").toString().split(",")[0].replace(/[.\u00b7;]+/g," ").replace(/\s+/g," ").trim();
  const parts = t.split(" ");
  while(parts.length > 1){
    const l1 = normTexto(parts[parts.length-1]);
    const l2 = parts.length > 2 ? normTexto(parts.slice(-2).join(" ")) : "";
    if(l2 && ESTADOS_US.has(l2)){ parts.splice(-2,2); continue; }
    if(ESTADOS_US.has(l1)){ parts.pop(); continue; }
    break;
  }
  return parts.join(" ").trim();
}
// Deja solo los dígitos de un valor (para teléfono y código postal).
function soloNum(t){ return (t||"").toString().replace(/[^0-9]/g,""); }
// ─── GENERADOR DE ID ÚNICO ───
// Date.now()+Math.random() puede COLISIONAR cuando se crean muchos registros en el
// mismo milisegundo (ej. importación masiva con IA): dos clientes terminan con el mismo
// id y al editar/borrar uno se afecta el otro. Este generador combina timestamp +
// contador incremental + base36 aleatorio → id ÚNICO garantizado, siempre string.
let __idCounter = 0;
function genId(){
  __idCounter = (__idCounter + 1) % 1000000;
  return `${Date.now().toString(36)}-${__idCounter.toString(36)}-${Math.random().toString(36).slice(2,8)}`;
}
// Repara IDs DUPLICADOS o vacíos en una lista de registros, SIN borrar datos.
// Si dos clientes comparten id (por el bug viejo de Date.now()+Math.random()), al
// segundo y siguientes se les asigna un id nuevo único. Devuelve {lista, reparados}.
function repararIdsLista(lista){
  if(!Array.isArray(lista)) return { lista, reparados:0 };
  const vistos = new Set();
  let reparados = 0;
  const out = lista.map(item=>{
    if(!item || typeof item!=="object") return item;
    let id = item.id;
    const idStr = (id===undefined||id===null) ? "" : String(id);
    if(idStr==="" || vistos.has(idStr)){
      reparados++;
      const nuevo = genId();
      vistos.add(nuevo);
      return { ...item, id: nuevo };
    }
    vistos.add(idStr);
    return item;
  });
  return { lista: out, reparados };
}
// Repara IDs duplicados en TODAS las secciones de clientes del estado.
function repararIdsEstado(estado){
  if(!estado || typeof estado!=="object") return estado;
  const secciones = ["agregados","prospectos","distribucion","referidos"];
  let totalRep = 0;
  const nuevo = { ...estado };
  secciones.forEach(sec=>{
    if(Array.isArray(nuevo[sec])){
      const { lista, reparados } = repararIdsLista(nuevo[sec]);
      if(reparados>0){ nuevo[sec] = lista; totalRep += reparados; }
    }
  });
  return totalRep>0 ? nuevo : estado;
}
// Normaliza un código postal: quita todo lo que no sea número y toma los primeros 5 dígitos.
// Así "75061-1234" (ZIP+4) → "75061", y " 765 01 " → "76501".
function normalizeZip(value){ return String(value||"").replace(/\D/g,"").slice(0,5); }
// Extrae un código postal de 5 dígitos que esté ESCRITO DENTRO de un texto (dirección).
// Busca un grupo de exactamente 5 dígitos juntos. Ej: "123 Main St, Dallas TX 75220" → "75220".
// Si hay ZIP+4 como "75220-1234", toma los primeros 5. Si hay varios, toma el último
// (normalmente el ZIP va al final de la dirección).
function zipDesdeTexto(texto){
  const s=String(texto||"");
  // \b(\d{5})(?:-\d{4})?\b → 5 dígitos, opcional -4, con límites de palabra
  const matches=[...s.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].map(m=>m[1]);
  return matches.length>0 ? matches[matches.length-1] : "";
}
// Lee el código postal de un cliente (5 díg). Primero busca en los campos de CP;
// si están vacíos, lo EXTRAE de la dirección (donde suele venir escrito).
function cpDe(c){
  const campoCP = normalizeZip(c?.cp||c?.codigoPostal||c?.postalCode||c?.zip||c?.addressZip||c?.codigo_postal);
  if(campoCP.length===5) return campoCP;
  // No hay CP en su propio campo → buscar 5 dígitos juntos en la dirección
  const enDireccion = zipDesdeTexto(c?.direccion||c?.address||c?.direccion_completa);
  // F) Garantizar que el ZIP extraído sea EXACTAMENTE 5 dígitos (si no, "")
  return enDireccion.length===5 ? enDireccion : "";
}
// Lee el teléfono de un cliente (cliente normal o anfitrión de referido).
function telDe(c){ return soloNum(c?.telefono||c?.anfitrion_telefono||c?.tel); }

// FILTRO GLOBAL ÚNICO. Devuelve true si el cliente cumple TODOS los filtros activos.
// Reglas:
//  - search: busca en nombre, anfitrión, ciudad, estado, dirección, teléfono y CP
//  - filterStatus: estado exacto ("todos" = sin filtro)
//  - filterCity: ciudad por coincidencia parcial sin acentos
//  - filterCP: EXACTO con 5 dígitos. Menos de 5 dígitos NO filtra (no parcial).
function coincideBusqueda(c, filtros){
  const { search="", filterStatus="todos", filterCity="", filterCP="" } = filtros||{};
  // Código postal — solo filtra cuando hay 5 dígitos completos, y compara EXACTO
  const zipRaw = soloNum(filterCP);
  const zipQuery = normalizeZip(filterCP);
  // Si empezó a escribir un ZIP pero aún NO son 5 dígitos (1-4), NO mostrar nada.
  // Esto evita que aparezcan clientes incorrectos mientras el filtro está incompleto.
  if(zipRaw.length>0 && zipRaw.length<5) return false;
  const cpCliente = cpDe(c);
  const shouldFilterByZip = zipQuery.length===5;
  const mcp = !shouldFilterByZip || cpCliente===zipQuery;
  // Ciudad (sin acentos, parcial — esto sí puede ser parcial)
  const mc = !filterCity || normTexto(c?.ciudad).includes(normTexto(filterCity));
  // Estado
  const mf = !filterStatus || filterStatus==="todos" || c?.estado===filterStatus;
  // Búsqueda libre
  let ms = true;
  if(search && search.trim()){
    const q = normTexto(search);
    const qNum = soloNum(search);
    const nombre = normTexto(c?.nombre);
    const anfitrion = normTexto(c?.anfitrion);
    const ciudad = normTexto(c?.ciudad);
    const estado = normTexto(c?.estado);
    const direccion = normTexto(c?.direccion);
    const tel = telDe(c);
    const coincideTexto = nombre.includes(q)||anfitrion.includes(q)||ciudad.includes(q)||estado.includes(q)||direccion.includes(q);
    // Coincidencia por teléfono SOLO si la búsqueda es básicamente un número (mín 3 díg),
    // no texto que casualmente trae un dígito (ej. "calle 5").
    const busquedaEsNumerica = qNum.length>=3 && qNum.length>=q.replace(/[^a-z0-9]/g,"").length;
    const coincideTel = busquedaEsNumerica && tel.includes(qNum);
    // Coincidencia por CP en la búsqueda libre: también exacto con 5 dígitos
    const coincideCp = qNum.length===5 && cpCliente===qNum;
    ms = coincideTexto || coincideTel || coincideCp;
  }
  return ms && mf && mc && mcp;
}
// Apps de llamada. iOS no permite que una web abra apps de terceros
// directamente, así que: tel/GVoice abren con el número listo, y
// TextNow/iPlum copian el número automático (solo abres la app y pegas).
const copyNum = (n) => { try { navigator.clipboard.writeText(intlNum(n)); } catch {} };
const CALL_APPS = [
  { id:"tel",     label:"Teléfono",      icon:"📞", color:"#7c3aed", mode:"link", href:(n)=>telLink(n) },
  { id:"gvoice",  label:"Google Voice",  icon:"📱", color:"#1a73e8", mode:"link", href:(n)=>`https://voice.google.com/u/0/calls?a=nc,${encodeURIComponent(intlNum(n))}` },
  { id:"textnow", label:"TextNow",       icon:"☎️", color:"#65c466", mode:"copy" },
  { id:"iplum",   label:"iPlum",         icon:"🔵", color:"#0a6cff", mode:"copy" },
];


// ─── GOOGLE CALENDAR LINK (evento pre-llenado, funciona en cualquier lado) ──
const fmtGCal = (d) => {
  const p = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
};
function gcalLink(appt) {
  const start = new Date(appt.fecha);
  const end   = new Date(start.getTime() + 3600000);
  const cfg   = EVENT_CONFIG[appt.tipo] || EVENT_CONFIG.cita;
  const guestList = (appt.invitados||[]).filter(Boolean).join(", ");
  const details = [
    `Tel: ${appt.telefono||"—"}`,
    `Producto: ${appt.producto||"—"}`,
    appt.cuenta ? `Cuenta: ${appt.cuenta}` : "",
    appt.ciudad ? `Ciudad: ${appt.ciudad}${appt.cp?` · CP: ${appt.cp}`:""}` : (appt.cp?`CP: ${appt.cp}`:""),
    guestList ? `Invitados cocinada: ${guestList}` : "",
    appt.notas ? `Notas: ${appt.notas}` : "",
    `Vendedor: ${appt.agente||"—"}`,
  ].filter(Boolean).join("\n");
  const locationStr = [appt.direccion, appt.ciudad, appt.cp].filter(Boolean).join(", ");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text:   cfg.title(appt.nombre),
    dates:  `${fmtGCal(start)}/${fmtGCal(end)}`,
    details,
    location: locationStr || "",
    ctz: "America/Chicago",
  });
  const adds = (appt.attendees||[]).filter(Boolean).join(",");
  if (adds) params.append("add", adds);
  return "https://calendar.google.com/calendar/render?" + params.toString();
}

// ─── DUPLICATE DETECTION ──────────────────────────────────────
// Jerarquía: 1) n��mero de cuenta, 2) teléfono, 3) nombre + dirección.
const normName = (s)=>(s||"").toLowerCase().trim().replace(/\s+/g," ");
const normTel  = (s)=>{ let d=(s||"").replace(/[^0-9]/g,""); if(d.length>10)d=d.slice(-10); return d; };
const normCuenta = (s)=>(s||"").toString().replace(/[^0-9a-zA-Z]/g,"").toLowerCase();
const normDir  = (s)=>(s||"").toLowerCase().trim().replace(/\s+/g," ").replace(/[.,#]/g,"");
const contactKey = (c)=> normName(c.nombre)+"|"+normTel(c.telefono);

// Devuelve el cliente existente que coincide (o null), siguiendo la jerarquía.
function findDuplicate(contact, allData, excludeId=null) {
  const cuenta = normCuenta(contact.cuenta || contact.numeroCuenta);
  const tel = normTel(contact.telefono || contact.telefonoMovil);
  const nombre = normName(contact.nombre);
  const dir = normDir(contact.direccion);
  for (const sec of ["agregados","prospectos","distribucion"]) {
    for (const x of (allData[sec]||[])) {
      if (x.id===excludeId || x.eliminado) continue;
      // 1) por cuenta
      if (cuenta && normCuenta(x.cuenta)===cuenta) return {match:x, sec, motivo:"número de cuenta"};
    }
  }
  for (const sec of ["agregados","prospectos","distribucion"]) {
    for (const x of (allData[sec]||[])) {
      if (x.id===excludeId || x.eliminado) continue;
      // 2) por teléfono (solo si el nuevo no tenía cuenta que matcheara)
      if (tel && normTel(x.telefono)===tel) return {match:x, sec, motivo:"teléfono"};
    }
  }
  for (const sec of ["agregados","prospectos","distribucion"]) {
    for (const x of (allData[sec]||[])) {
      if (x.id===excludeId || x.eliminado) continue;
      // 3) por nombre + dirección
      if (nombre && dir && normName(x.nombre)===nombre && normDir(x.direccion)===dir) return {match:x, sec, motivo:"nombre y dirección"};
    }
  }
  return null;
}
// Compatibilidad: isDuplicate / dupReason siguen funcionando
function isDuplicate(contact, allData, excludeId=null) {
  return !!findDuplicate(contact, allData, excludeId);
}
function dupReason(contact, allData) {
  const d = findDuplicate(contact, allData);
  return d ? d.motivo : "";
}
// Cuenta cuántos campos útiles tiene un cliente (para decidir cuál conservar)
function contarCampos(c) {
  const campos = ["nombre","cuenta","direccion","telefono","telefonoCasa","telefonoTrabajo","telefonoMovil","vendedor","nivelCliente","limiteCredito","saldoActual","otrosDetalles","ciudad","observaciones"];
  let n = campos.reduce((acc,k)=> acc + ((c[k]&&String(c[k]).trim())?1:0), 0);
  if(Array.isArray(c.productos) && c.productos.length) n++;
  return n;
}
// Fusiona dos clientes: rellena vacíos del existente con datos del nuevo.
// Conserva toda la info útil de ambos. No borra nada.
function fusionarClientes(existente, nuevo) {
  const merged = {...existente};
  const campos = ["nombre","cuenta","direccion","telefono","telefonoCasa","telefonoTrabajo","telefonoMovil","vendedor","nivelCliente","limiteCredito","saldoActual","otrosDetalles","ciudad"];
  campos.forEach(k=>{
    const vNuevo = nuevo[k]!==undefined ? nuevo[k] : nuevo[k==="cuenta"?"numeroCuenta":k];
    if((!merged[k] || !String(merged[k]).trim()) && vNuevo && String(vNuevo).trim()){
      merged[k] = vNuevo;
    }
  });
  // Productos: unir sin duplicar
  const prodEx = Array.isArray(existente.productos)?existente.productos:[];
  const prodNew = Array.isArray(nuevo.productos)?nuevo.productos:(nuevo.productos?[nuevo.productos]:[]);
  const prodSet = [...new Set([...prodEx, ...prodNew].map(p=>String(p).trim()).filter(Boolean))];
  if(prodSet.length) merged.productos = prodSet;
  // Observaciones: concatenar si el nuevo aporta algo distinto
  if(nuevo.observaciones && nuevo.observaciones.trim() && nuevo.observaciones.trim()!==(existente.observaciones||"").trim()){
    merged.observaciones = [existente.observaciones, nuevo.observaciones].filter(Boolean).join(" · ");
  }
  merged.actualizado = new Date().toISOString();
  return merged;
}

// ─── PDF EXPORT (Royal style) ─────────────────────────────────
function exportToPDF(data, sectionName) {
  const rows = data.map(c=>{
    const name=c.anfitrion||c.nombre||"(Sin nombre)", tel=c.telefono||c.referidos?.[0]?.telefono||"",
      prod=c.producto||"", dir=c.direccion||"", status=STATUS_COLORS[c.estado]?.label||"Sin estado", obs=c.observaciones||"";
    return `<tr style="border-bottom:1px solid #e8edf3">
      <td style="padding:8px 10px;font-weight:700;color:#1f2d3d">${name}</td>
      <td style="padding:8px 10px;color:#555">${tel}</td>
      <td style="padding:8px 10px;color:#555">${prod}</td>
      <td style="padding:8px 10px;color:#555;max-width:140px">${dir}</td>
      <td style="padding:8px 10px"><span style="background:#5b21b6;color:#fff;border-radius:6px;padding:2px 9px;font-size:10px;font-weight:700">${status}</span></td>
      <td style="padding:8px 10px;color:#888;font-style:italic;font-size:10px">${obs}</td></tr>`;
  }).join("");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Royal Prestige — ${sectionName}</title>
  <style>@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=swap');
  body{font-family:'Helvetica Neue',Arial,sans-serif;margin:0;padding:24px;color:#1f2d3d}
  .bar{background:#5b21b6;color:#fff;padding:20px 24px;border-radius:14px;margin-bottom:20px}
  h1{font-family:'Playfair Display',Georgia,serif;font-size:24px;font-weight:700;margin:0}
  h1 span{font-style:italic;color:#a78bfa}
  .sub{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#c4b5fd;margin-top:6px}
  table{width:100%;border-collapse:collapse;font-size:11px}
  th{background:#3b0d8f;color:#fff;padding:10px;text-align:left;font-weight:700;font-size:11px}
  tr:nth-child(even){background:#f4f6f9}
  @media print{body{padding:10px}}</style></head>
  <body><div class="bar"><h1>Royal <span>Prestige</span> — ${sectionName}</h1>
  <div class="sub">Telemarketing Impact Enterprises · ${new Date().toLocaleDateString("es-MX",{day:"numeric",month:"long",year:"numeric"})} · ${data.length} registros</div></div>
  <div class="noprint" style="position:fixed;top:12px;right:12px;display:flex;gap:8px;z-index:99">
    <button onclick="window.print()" style="background:#5b21b6;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-weight:700;font-size:14px;cursor:pointer">🖨️ Imprimir</button>
    <button onclick="window.close();history.back();" style="background:#e2e8f0;color:#475569;border:none;border-radius:10px;padding:10px 16px;font-weight:700;font-size:14px;cursor:pointer">✕ Cerrar</button>
  </div>
  <style>.noprint{} @media print{.noprint{display:none!important}}</style>
  <table><thead><tr><th>Nombre</th><th>Teléfono</th><th>Producto</th><th>Dirección</th><th>Estado</th><th>Observaciones</th></tr></thead>
  <tbody>${rows}</tbody></table></body></html>`;
  // Usar Blob + nueva pestaña con botón de cerrar (en iPhone window.open con print atrapa la vista)
  try {
    const blob = new Blob([html], { type:"text/html" });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    if(!w){
      // Si el navegador bloquea la ventana, descargar el archivo
      const a = document.createElement("a");
      a.href = url; a.download = `RoyalPrestige_${sectionName}_${hoyLocal()}.html`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }
    setTimeout(()=>URL.revokeObjectURL(url), 60000);
  } catch(e) {
    alert("No se pudo generar el PDF: "+(e?.message||e));
  }
}

// ════════════════════════════════════════════════════════════════
// COFRE IMPACT SEMANAL + RESPALDO MENSUAL
// ════════════════════════════════════════════════════════════════

// Niveles por defecto del Cofre (editables por el encargado)
const COFRE_NIVELES_DEFAULT = [
  { id:"bronce", nombre:"Cofre Bronce", emoji:"🥉", color:"#b06b2f", metaCitas:0, metaDemos:0, metaVentas:0, metaVolumen:0, premios:[] },
  { id:"plata",  nombre:"Cofre Plata",  emoji:"🥈", color:"#8a97a8", metaCitas:0, metaDemos:0, metaVentas:0, metaVolumen:0, premios:[] },
  { id:"oro",    nombre:"Cofre Oro",    emoji:"🥇", color:"#caa12f", metaCitas:0, metaDemos:0, metaVentas:0, metaVolumen:0, premios:[] },
];

// Llave de la semana actual = fecha (ISO) del lunes de esta semana
function semanaActualKey(){ return lunesDeLaSemana(new Date()).toISOString().slice(0,10); }

// Logro de ESTA semana (lunes 00:00 → ahora) para un agente
function calcularSemanaAgente(agente, allData){
  const lunes = lunesDeLaSemana(new Date());
  const ahora = new Date();
  const enSemana = (fechaISO)=>{ if(!fechaISO) return false; const f=new Date(fechaISO); return f>=lunes && f<=ahora; };
  const clientes = [
    ...(allData.agregados||[]),
    ...(allData.prospectos||[]),
    ...(allData.distribucion||[]),
    ...((allData.referidos||[]).flatMap(anf=>(anf.referidos||[]))),
  ];
  let citas=0, demos=0, ventas=0, volumen=0;
  (allData.appts||[]).forEach(a=>{
    if(agente && a.agente!==agente) return;
    if(!enSemana(a.fecha)) return;
    if(a.tipo==="cita" || a._type==="cita") citas++;
    if((a.resultado==="demo_venta"||a.resultado==="venta") && a.monto) volumen += Number(a.monto)||0;
  });
  clientes.forEach(c=>{
    (c.historial||[]).forEach(h=>{
      if(agente && h.agente!==agente) return;
      if(!enSemana(h.fecha)) return;
      if(h.cita_resultado==="demo_venta"||h.cita_resultado==="demo_no_venta"||h.cita_resultado==="venta"||h.cita_resultado==="no_venta") demos++;
      if(h.cita_resultado==="demo_venta"||h.cita_resultado==="venta"){ ventas++; if(h.monto) volumen += Number(h.monto)||0; }
    });
  });
  return { citas, demos, ventas, volumen };
}

function cofreNivelTieneMetas(n){
  return (Number(n.metaCitas)||0)>0 || (Number(n.metaDemos)||0)>0 || (Number(n.metaVentas)||0)>0 || (Number(n.metaVolumen)||0)>0;
}
function cofreNivelCumplido(n, l){
  if(!cofreNivelTieneMetas(n)) return false;
  const mc=Number(n.metaCitas)||0, md=Number(n.metaDemos)||0, mv=Number(n.metaVentas)||0, mvo=Number(n.metaVolumen)||0;
  if(mc>0  && l.citas   < mc)  return false;
  if(md>0  && l.demos   < md)  return false;
  if(mv>0  && l.ventas  < mv)  return false;
  if(mvo>0 && l.volumen < mvo) return false;
  return true;
}
function cofreProgresoNivel(n, l){
  const partes=[];
  const mc=Number(n.metaCitas)||0, md=Number(n.metaDemos)||0, mv=Number(n.metaVentas)||0, mvo=Number(n.metaVolumen)||0;
  if(mc>0)  partes.push(Math.min(1, l.citas/mc));
  if(md>0)  partes.push(Math.min(1, l.demos/md));
  if(mv>0)  partes.push(Math.min(1, l.ventas/mv));
  if(mvo>0) partes.push(Math.min(1, l.volumen/mvo));
  return partes.length ? Math.round(partes.reduce((a,b)=>a+b,0)/partes.length*100) : 0;
}
// Nivel más alto cumplido (asume orden bronce → plata → oro)
function cofreNivelMaxCumplido(niveles, l){
  let max=null;
  (niveles||[]).forEach(n=>{ if(cofreNivelCumplido(n,l)) max=n; });
  return max;
}

// Mini barra de meta (para la tarjeta del cofre)
function CofreMiniMeta({ label, actual, meta, money }){
  const m=Number(meta)||0;
  const pct=m>0 ? Math.min(100, Math.round((Number(actual)||0)/m*100)) : 0;
  const fmt=(v)=> money ? "$"+(Number(v)||0).toLocaleString("en-US") : (Number(v)||0);
  return (
    <div className="bg-[#f4f6f9] rounded-lg px-2.5 py-1.5">
      <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
        <span>{label}</span>
        <span className={pct>=100?"text-emerald-600":"text-slate-600"}>{fmt(actual)} / {fmt(meta)}</span>
      </div>
      <div className="h-1.5 bg-slate-200 rounded-full mt-1 overflow-hidden">
        <div className="h-full rounded-full" style={{width:pct+"%", background:pct>=100?"#16a34a":RP.navy}}></div>
      </div>
    </div>
  );
}

// Tarjeta del Cofre en el Inicio del agente
function CofreSemanal({ cofreConfig, cofreAperturas, agente, allData, onAbrir }){
  const [revelado,setRevelado]=useState(null);
  const cfg=cofreConfig||{};
  const niveles=cfg.niveles||[];
  const activo = cfg.activo!==false && niveles.some(cofreNivelTieneMetas);
  if(!activo) return null;

  const logro=calcularSemanaAgente(agente, allData);
  const semana=semanaActualKey();
  const apertura=(cofreAperturas||[]).find(a=>a.agente===agente && a.semana===semana);
  const maxNivel=cofreNivelMaxCumplido(niveles, logro);

  const abrir=()=>{
    if(!maxNivel || apertura) return;
    const premios=(maxNivel.premios||[]).filter(p=>p && p.texto && p.texto.trim());
    const premio = premios.length ? premios[Math.floor(Math.random()*premios.length)].texto : "🎉 ¡Felicidades, lo lograste!";
    setRevelado({ nivel:maxNivel, premio });
    onAbrir(agente, maxNivel, premio);
  };

  return (
    <div className="rounded-2xl bg-white border-2 border-amber-200 overflow-hidden shadow-sm">
      <div className="px-4 py-3 bg-gradient-to-r from-amber-50 to-yellow-50 flex items-center justify-between">
        <div className="text-sm font-black text-amber-700"><Ico e="🎁" className="mr-1.5" />Cofre Impact Semanal</div>
        <span className="text-[10px] font-bold text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full">Reinicia cada lunes</span>
      </div>
      <div className="p-4 space-y-3">
        {niveles.filter(cofreNivelTieneMetas).map(n=>{
          const pct=cofreProgresoNivel(n, logro);
          const cumplido=cofreNivelCumplido(n, logro);
          return (
            <div key={n.id} className="rounded-xl border border-[#e8edf3] p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="font-black text-sm" style={{color:n.color}}>{n.emoji} {n.nombre}</div>
                <div className="text-xs font-black" style={{color:cumplido?"#16a34a":"#94a3b8"}}>{cumplido?<><Ico e="✅" className="mr-1" />Logrado</>:pct+"%"}</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {Number(n.metaCitas)>0   && <CofreMiniMeta label="Citas"   actual={logro.citas}   meta={n.metaCitas} />}
                {Number(n.metaDemos)>0   && <CofreMiniMeta label="Demos"   actual={logro.demos}   meta={n.metaDemos} />}
                {Number(n.metaVentas)>0  && <CofreMiniMeta label="Ventas"  actual={logro.ventas}  meta={n.metaVentas} />}
                {Number(n.metaVolumen)>0 && <CofreMiniMeta label="Volumen" actual={logro.volumen} meta={n.metaVolumen} money />}
              </div>
            </div>
          );
        })}

        {apertura ? (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-center">
            <div className="text-xs font-bold text-emerald-700">Ya abriste tu cofre esta semana</div>
            <div className="text-lg font-black text-emerald-800 mt-1">{apertura.emoji} {apertura.nivelNombre}</div>
            <div className="text-sm text-emerald-700 mt-1"><Ico e="🎉" className="mr-1.5" />Premio: <b>{apertura.premio}</b></div>
          </div>
        ) : revelado ? (
          <div className="rounded-xl bg-amber-50 border border-amber-300 p-4 text-center">
            <div className="text-3xl mb-1"><Ico e={revelado.nivel.emoji} size={26} className="text-[#C8A24A]" /></div>
            <div className="text-sm font-black text-amber-800">¡Abriste el {revelado.nivel.nombre}!</div>
            <div className="text-base font-black text-amber-900 mt-1">Premio: {revelado.premio}</div>
          </div>
        ) : maxNivel ? (
          <button onClick={abrir} className="w-full py-3 rounded-xl text-white font-black text-sm active:scale-95 transition" style={{background:"linear-gradient(90deg,#c8901f,#e0b53a)"}}>
            <Ico e="🔓" className="mr-1.5" />Abrir {maxNivel.emoji} {maxNivel.nombre}
          </button>
        ) : (
          <div className="text-center text-xs text-slate-400 font-bold py-1">Sigue trabajando — aún no alcanzas ningún cofre esta semana 💪</div>
        )}
      </div>
    </div>
  );
}

// Editor de un nivel del cofre (metas + premios)
function CofreNivelEditor({ nivel, onChange, onClose }){
  const [nombre,setNombre]=useState(nivel.nombre);
  const [mc,setMc]=useState(nivel.metaCitas||"");
  const [md,setMd]=useState(nivel.metaDemos||"");
  const [mv,setMv]=useState(nivel.metaVentas||"");
  const [mvo,setMvo]=useState(nivel.metaVolumen||"");
  const [premios,setPremios]=useState((nivel.premios||[]).map(p=>({...p})));
  const [nuevo,setNuevo]=useState("");

  const addPremio=()=>{ const t=nuevo.trim(); if(!t) return; setPremios(p=>[...p,{id:genId(),texto:t}]); setNuevo(""); };
  const editPremio=(id,t)=> setPremios(p=>p.map(x=>x.id===id?{...x,texto:t}:x));
  const delPremio=(id)=> setPremios(p=>p.filter(x=>x.id!==id));

  const guardar=()=>{
    onChange({ nombre:(nombre||"").trim()||nivel.nombre, metaCitas:Number(mc)||0, metaDemos:Number(md)||0, metaVentas:Number(mv)||0, metaVolumen:Number(mvo)||0, premios:premios.filter(p=>p.texto && p.texto.trim()) });
    onClose();
  };

  return (
    <div>
      <Field label="Nombre del cofre"><input className={inpLight} value={nombre} onChange={e=>setNombre(e.target.value)} /></Field>
      <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2 mt-2">Metas de la semana</div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Meta de citas"><input className={inpLight} inputMode="numeric" value={mc} onChange={e=>setMc(e.target.value.replace(/[^0-9]/g,""))} placeholder="0" /></Field>
        <Field label="Meta de demos"><input className={inpLight} inputMode="numeric" value={md} onChange={e=>setMd(e.target.value.replace(/[^0-9]/g,""))} placeholder="0" /></Field>
        <Field label="Meta de ventas"><input className={inpLight} inputMode="numeric" value={mv} onChange={e=>setMv(e.target.value.replace(/[^0-9]/g,""))} placeholder="0" /></Field>
        <Field label="Meta de volumen ($)"><input className={inpLight} inputMode="numeric" value={mvo} onChange={e=>setMvo(e.target.value.replace(/[^0-9]/g,""))} placeholder="0" /></Field>
      </div>
      <div className="text-[11px] text-slate-400 mb-3">Deja en 0 las metas que no apliquen a este cofre.</div>

      <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Premios posibles</div>
      <div className="space-y-2 mb-3">
        {premios.length===0 && <div className="text-[11px] text-slate-400">Aún no hay premios. Agrega al menos uno.</div>}
        {premios.map(p=>(
          <div key={p.id} className="flex items-center gap-2">
            <input className={inpLight} value={p.texto} onChange={e=>editPremio(p.id,e.target.value)} />
            <button onClick={()=>delPremio(p.id)} className="text-red-400 font-bold text-sm shrink-0 px-2"><Ico e="✕" /></button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mb-4">
        <input className={inpLight} value={nuevo} onChange={e=>setNuevo(e.target.value)} placeholder="Nuevo premio…" onKeyDown={e=>{ if(e.key==="Enter"){ e.preventDefault(); addPremio(); } }} />
        <button onClick={addPremio} className="px-3 py-2 rounded-lg text-xs font-bold text-white shrink-0" style={{background:RP.navy}}>+ Agregar</button>
      </div>

      <button onClick={guardar} className="w-full py-3 rounded-xl text-white font-black text-sm" style={{background:RP.navy}}>Guardar cofre</button>
    </div>
  );
}

// Tarjeta de configuración del Cofre (dentro de Incentivos)
function CofreConfigCard({ cofreConfig, setCofreConfig, rolActivo }){
  const puede=puedeCrearIncentivosRol(rolActivo);
  const fallback = ()=>({ activo:true, niveles:COFRE_NIVELES_DEFAULT.map(n=>({...n,premios:[]})) });
  const cfg = (cofreConfig && cofreConfig.niveles) ? cofreConfig : fallback();
  const [editId,setEditId]=useState(null);

  const setNivel=(id, patch)=>{
    setCofreConfig(prev=>{
      const base = (prev && prev.niveles) ? prev : fallback();
      return {...base, niveles: base.niveles.map(n=>n.id===id?{...n,...patch}:n)};
    });
  };
  const toggleActivo=()=> setCofreConfig(prev=>{
    const base = (prev && prev.niveles) ? prev : fallback();
    return {...base, activo: base.activo===false };
  });

  const nivelEdit = cfg.niveles.find(n=>n.id===editId);

  return (
    <div className="rounded-2xl bg-white border-2 border-amber-200 overflow-hidden shadow-sm">
      <div className="px-4 py-3 bg-gradient-to-r from-amber-50 to-yellow-50 flex items-center justify-between">
        <div>
          <div className="text-sm font-black text-amber-700"><Ico e="🎁" className="mr-1.5" />Cofre Impact Semanal</div>
          <div className="text-[11px] text-amber-600/80">Incentivo semanal · reinicia cada lunes · no se acumula</div>
        </div>
        {puede && <button onClick={toggleActivo} className={`px-3 py-1.5 rounded-full text-[11px] font-black ${cfg.activo!==false?"bg-emerald-100 text-emerald-700":"bg-slate-200 text-slate-500"}`}>{cfg.activo!==false?"Activo":"Apagado"}</button>}
      </div>
      <div className="p-4 space-y-2">
        {cfg.niveles.map(n=>{
          const metas=[
            Number(n.metaCitas)>0   && `${n.metaCitas} citas`,
            Number(n.metaDemos)>0   && `${n.metaDemos} demos`,
            Number(n.metaVentas)>0  && `${n.metaVentas} ventas`,
            Number(n.metaVolumen)>0 && `$${n.metaVolumen} vol.`,
          ].filter(Boolean).join(" · ") || "Sin metas definidas";
          const numPremios=(n.premios||[]).filter(p=>p && p.texto && p.texto.trim()).length;
          return (
            <div key={n.id} className="rounded-xl border border-[#e8edf3] p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-black text-sm" style={{color:n.color}}>{n.emoji} {n.nombre}</div>
                <div className="text-[11px] text-slate-500 truncate">{metas}</div>
                <div className="text-[11px] text-slate-400">{numPremios} premio(s)</div>
              </div>
              {puede && <button onClick={()=>setEditId(n.id)} className="px-3 py-2 rounded-lg text-xs font-bold text-white shrink-0" style={{background:RP.navy}}>Editar</button>}
            </div>
          );
        })}
        {!puede && <div className="text-[11px] text-slate-400">Solo el encargado puede editar los cofres.</div>}
      </div>

      {nivelEdit && (
        <Modal title={`${nivelEdit.emoji} ${nivelEdit.nombre}`} onClose={()=>setEditId(null)}>
          <CofreNivelEditor nivel={nivelEdit} onChange={(patch)=>setNivel(nivelEdit.id,patch)} onClose={()=>setEditId(null)} />
        </Modal>
      )}
    </div>
  );
}

// Botón / recordatorio de Respaldo mensual (Inicio del distribuidor)
function RespaldoBox({ allData, appts, callLog, respaldos, registrarRespaldo, rolActivo }){
  const puede=puedeExportarRol(rolActivo); // Distribuidor y Supervisor
  const [abierto,setAbierto]=useState(false);
  if(!puede) return null;

  const hoy=new Date();
  const mesActual=hoy.toISOString().slice(0,7); // YYYY-MM
  const yaRespaldado=(respaldos||[]).some(r=>r.mes===mesActual);
  const prev=new Date(hoy.getFullYear(), hoy.getMonth()-1, 1);
  const prevKey=prev.toISOString().slice(0,7);
  const nombreMes=(d)=> d.toLocaleDateString("es-MX",{month:"long",year:"numeric"});
  const destacar=!yaRespaldado;

  const generar=(tipo)=>{
    exportRespaldo(allData, appts, callLog, { tipo, mesKey: tipo==="mes"?prevKey:null, mesNombre: tipo==="mes"?nombreMes(prev):"" });
    registrarRespaldo(mesActual, tipo);
    setAbierto(false);
  };

  return (
    <div className={`rounded-2xl overflow-hidden shadow-sm border-2 ${destacar?"border-purple-300":"border-[#e8edf3]"}`}>
      <div className={`px-4 py-3 flex items-center justify-between ${destacar?"bg-purple-50":"bg-white"}`}>
        <div>
          <div className="text-sm font-black text-[#5b21b6]"><Ico e="📦" className="mr-1.5" />Guardar Respaldo</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {destacar ? `Inicio de mes — guarda el respaldo de ${nombreMes(hoy)}` : <><Ico e="✅" className="mr-1" />Ya guardaste un respaldo este mes</>}
          </div>
        </div>
        <button onClick={()=>setAbierto(v=>!v)} className="px-3 py-2 rounded-lg text-xs font-black text-white shrink-0" style={{background:RP.navy}}>{abierto?"Cerrar":"Generar"}</button>
      </div>
      {abierto && (
        <div className="p-4 bg-white border-t border-[#e8edf3] space-y-2">
          <button onClick={()=>generar("completo")} className="w-full text-left px-4 py-3 rounded-xl border border-[#e5def4] bg-[#f4f6f9] active:scale-[0.99] transition">
            <div className="font-black text-sm text-[#1f2d3d]"><Ico e="📋" className="mr-1.5" />Respaldo completo</div>
            <div className="text-[11px] text-slate-500">Todo lo que hay ahora: citas, las 4 bases, historial y servicios.</div>
          </button>
          <button onClick={()=>generar("mes")} className="w-full text-left px-4 py-3 rounded-xl border border-[#e5def4] bg-[#f4f6f9] active:scale-[0.99] transition">
            <div className="font-black text-sm text-[#1f2d3d]"><Ico e="📅" className="mr-1.5" />Cierre de mes</div>
            <div className="text-[11px] text-slate-500">Solo la actividad de {nombreMes(prev)} (el mes que cerró).</div>
          </button>
        </div>
      )}
    </div>
  );
}

// Motor del PDF de respaldo (estilo Royal, Blob + pestaña — seguro en iPhone)
function exportRespaldo(allData, appts, callLog, opts){
  const o=opts||{};
  const esMes = o.tipo==="mes" && !!o.mesKey;
  const mesKey=o.mesKey;
  const enMes=(fechaISO)=>{ if(!esMes) return true; if(!fechaISO) return false; return String(fechaISO).slice(0,7)===mesKey; };
  const esc=(v)=> String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const fmtFecha=(iso)=>{ if(!iso) return ""; try{ return new Date(iso).toLocaleDateString("es-MX",{day:"2-digit",month:"2-digit",year:"numeric"}); }catch(e){ return String(iso).slice(0,10); } };
  const estadoLabel=(e)=> (STATUS_COLORS[e] && STATUS_COLORS[e].label) || "Sin estado";

  function seccion(titulo, n, contenido){
    return `<div class="sec"><h2>${esc(titulo)} <span class="cnt">${n} registro${n===1?"":"s"}</span></h2>${contenido}</div>`;
  }
  function secVacia(titulo){
    return `<div class="sec"><h2>${esc(titulo)} <span class="cnt">0</span></h2><div class="muted" style="padding:8px 0">Sin registros.</div></div>`;
  }

  // CITAS
  const citas=(appts||[]).filter(a=>(a.tipo==="cita"||a._type==="cita") && enMes(a.fecha)).sort((x,y)=>new Date(y.fecha||0)-new Date(x.fecha||0));
  // SERVICIOS
  const servicios=(appts||[]).filter(a=>a.tipo==="servicio" && enMes(a.fecha)).sort((x,y)=>new Date(y.fecha||0)-new Date(x.fecha||0));
  // HISTORIAL (de todos los clientes)
  const clientesTodos=[
    ...(allData.agregados||[]),
    ...(allData.prospectos||[]),
    ...(allData.distribucion||[]),
    ...((allData.referidos||[]).flatMap(anf=>(anf.referidos||[]))),
  ];
  const histRows=[];
  clientesTodos.forEach(c=>{
    (c.historial||[]).forEach(h=>{
      if(!enMes(h.fecha)) return;
      histRows.push({ fecha:h.fecha, cliente:c.nombre||c.anfitrion||"(Sin nombre)", agente:h.agente||"", resultado:h.cita_resultado||h.resultado||h.tipo||"", nota:h.nota||h.observacion||"" });
    });
  });
  histRows.sort((a,b)=>new Date(b.fecha||0)-new Date(a.fecha||0));

  // BASES (en modo mes: solo clientes con actividad ese mes)
  const baseRows=(arr)=> (arr||[]).filter(c=>!c.eliminado && (!esMes || (c.historial||[]).some(h=>enMes(h.fecha))));
  const agregados=baseRows(allData.agregados);
  const prospectos=baseRows(allData.prospectos);
  const distribucion=baseRows(allData.distribucion);
  const referidosAnf=(allData.referidos||[]).filter(anf=>!anf.eliminado && (!esMes || (anf.referidos||[]).some(r=>(r.historial||[]).some(h=>enMes(h.fecha)))));

  const tablaClientes=(titulo, arr)=>{
    if(!arr.length) return secVacia(titulo);
    const filas=arr.map(c=>`<tr>
      <td class="b">${esc(c.nombre||c.anfitrion||"(Sin nombre)")}</td>
      <td>${esc(c.telefono||"")}</td>
      <td>${esc(c.ciudad||c.anfitrion_ciudad||"")}</td>
      <td>${esc(c.cp||"")}</td>
      <td><span class="tag">${esc(estadoLabel(c.estado))}</span></td>
      <td class="muted">${esc(c.observaciones||"")}</td></tr>`).join("");
    return seccion(titulo, arr.length, `<table><thead><tr><th>Nombre</th><th>Teléfono</th><th>Ciudad</th><th>C.P.</th><th>Estado</th><th>Observaciones</th></tr></thead><tbody>${filas}</tbody></table>`);
  };
  const tablaReferidos=(arr)=>{
    if(!arr.length) return secVacia("Programa Referidos");
    let total=0;
    const bloques=arr.map(anf=>{
      const refs=(anf.referidos||[]);
      total+=refs.length;
      const filas=refs.map(r=>`<tr><td class="b">${esc(r.nombre||"")}</td><td>${esc(r.telefono||"")}</td><td>${esc(r.ciudad||"")}</td><td><span class="tag">${esc(estadoLabel(r.estado))}</span></td></tr>`).join("");
      return `<div class="anf">Anfitrión: <b>${esc(anf.anfitrion||"")}</b>${anf.regalo?` · Regalo: ${esc(anf.regalo)}`:""}</div>
      <table><thead><tr><th>Referido</th><th>Teléfono</th><th>Ciudad</th><th>Estado</th></tr></thead><tbody>${filas||'<tr><td colspan="4" class="muted">Sin referidos</td></tr>'}</tbody></table>`;
    }).join("");
    return seccion("Programa Referidos", total, bloques);
  };
  const tablaCitas=(titulo, arr)=>{
    if(!arr.length) return secVacia(titulo);
    const filas=arr.map(a=>`<tr><td>${esc(fmtFecha(a.fecha))}</td><td class="b">${esc(a.cliente||a.nombre||"")}</td><td>${esc(a.telefono||"")}</td><td>${esc(a.direccion||"")}</td><td>${esc(a.agente||"")}</td></tr>`).join("");
    return seccion(titulo, arr.length, `<table><thead><tr><th>Fecha</th><th>Cliente</th><th>Teléfono</th><th>Dirección</th><th>Agente</th></tr></thead><tbody>${filas}</tbody></table>`);
  };
  const tablaServicios=(arr)=>{
    if(!arr.length) return secVacia("Servicios");
    const filas=arr.map(a=>`<tr><td>${esc(fmtFecha(a.fecha))}</td><td class="b">${esc(a.cliente||a.nombre||"")}</td><td>${esc(a.telefono||"")}</td><td><span class="tag">${esc(a.servicioResultado||"pendiente")}</span></td><td class="muted">${esc(a.notas||a.nota||"")}</td></tr>`).join("");
    return seccion("Servicios", arr.length, `<table><thead><tr><th>Fecha</th><th>Cliente</th><th>Teléfono</th><th>Estado</th><th>Notas</th></tr></thead><tbody>${filas}</tbody></table>`);
  };
  const tablaHistorial=(arr)=>{
    if(!arr.length) return secVacia("Historial de llamadas");
    const filas=arr.map(h=>`<tr><td>${esc(fmtFecha(h.fecha))}</td><td class="b">${esc(h.cliente)}</td><td>${esc(h.agente)}</td><td><span class="tag">${esc(h.resultado)}</span></td><td class="muted">${esc(h.nota)}</td></tr>`).join("");
    return seccion("Historial de llamadas", arr.length, `<table><thead><tr><th>Fecha</th><th>Cliente</th><th>Agente</th><th>Resultado</th><th>Nota</th></tr></thead><tbody>${filas}</tbody></table>`);
  };
  const tablaCallLog=()=>{
    const entries=Object.entries(callLog||{}).filter(([d])=>enMes(d+"T00:00:00")).sort((a,b)=>String(b[0]).localeCompare(String(a[0])));
    if(!entries.length) return "";
    const filas=entries.map(([d,n])=>`<tr><td>${esc(fmtFecha(d+"T00:00:00"))}</td><td class="b">${esc(sumDia(n))}</td></tr>`).join("");
    return seccion("Conteo diario de llamadas", entries.length, `<table><thead><tr><th>Día</th><th>Llamadas</th></tr></thead><tbody>${filas}</tbody></table>`);
  };

  const titulo = esMes ? `Cierre de mes — ${esc(o.mesNombre||mesKey)}` : "Respaldo completo";
  const totalGeneral = citas.length+agregados.length+prospectos.length+distribucion.length+referidosAnf.length+servicios.length+histRows.length;

  const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Royal Prestige — ${titulo}</title>
  <style>@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=swap');
  body{font-family:'Helvetica Neue',Arial,sans-serif;margin:0;padding:24px;color:#1f2d3d;background:#fff}
  .bar{background:#5b21b6;color:#fff;padding:20px 24px;border-radius:14px;margin-bottom:18px}
  h1{font-family:'Playfair Display',Georgia,serif;font-size:24px;font-weight:700;margin:0}
  h1 span{font-style:italic;color:#a78bfa}
  .sub{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#c4b5fd;margin-top:6px}
  .sec{margin:0 0 22px}
  .sec h2{font-size:15px;color:#3b0d8f;border-bottom:2px solid #e8edf3;padding-bottom:6px;margin:18px 0 10px}
  .cnt{font-size:11px;color:#94a3b8;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:8px}
  th{background:#3b0d8f;color:#fff;padding:8px 10px;text-align:left;font-weight:700}
  td{padding:7px 10px;border-bottom:1px solid #eef2f6;vertical-align:top}
  tr:nth-child(even) td{background:#f7f9fc}
  .b{font-weight:700;color:#1f2d3d}
  .muted{color:#8a93a3;font-style:italic;font-size:10px}
  .tag{background:#5b21b6;color:#fff;border-radius:6px;padding:2px 8px;font-size:10px;font-weight:700;white-space:nowrap}
  .anf{margin:10px 0 4px;font-size:12px;color:#3b0d8f}
  @media print{body{padding:10px}.noprint{display:none!important}}</style></head>
  <body>
  <div class="bar"><h1>Royal <span>Prestige</span> — ${titulo}</h1>
  <div class="sub">Telemarketing Impact Enterprises · ${new Date().toLocaleDateString("es-MX",{day:"numeric",month:"long",year:"numeric"})} · ${totalGeneral} registros en total</div></div>
  <div class="noprint" style="position:fixed;top:12px;right:12px;display:flex;gap:8px;z-index:99">
    <button onclick="window.print()" style="background:#5b21b6;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-weight:700;font-size:14px;cursor:pointer">🖨️ Guardar PDF</button>
    <button onclick="window.close();history.back();" style="background:#e2e8f0;color:#475569;border:none;border-radius:10px;padding:10px 16px;font-weight:700;font-size:14px;cursor:pointer">✕ Cerrar</button>
  </div>
  ${tablaCitas("Citas", citas)}
  ${tablaClientes("Base · Clientes Agregados", agregados)}
  ${tablaReferidos(referidosAnf)}
  ${tablaClientes("Base · Prospección", prospectos)}
  ${tablaClientes("Base · Bajo Distribución", distribucion)}
  ${tablaHistorial(histRows)}
  ${tablaCallLog()}
  ${tablaServicios(servicios)}
  </body></html>`;

  try{
    const blob=new Blob([html],{type:"text/html"});
    const url=URL.createObjectURL(blob);
    const w=window.open(url,"_blank");
    if(!w){
      const a=document.createElement("a");
      a.href=url; a.download=`RoyalPrestige_Respaldo_${esMes?mesKey:hoyLocal()}.html`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  }catch(e){ alert("No se pudo generar el respaldo: "+((e && e.message)||e)); }
}


// ─── CLIENT FORM ─────────────────────────────────────────────
function ClientForm({ initial, onSave, onClose, type }) {
  const [d, setD] = useState(initial || (
    type==="referido"?emptyReferido(): type==="prospecto"?emptyProspecto(): type==="distribucion"?emptyDistribucion(): emptyClient()
  ));
  const set = (k,v)=>setD(p=>({...p,[k]:v}));

  if (type==="referido") return (
    <form onSubmit={e=>{e.preventDefault(); if(!(d.anfitrion||"").trim()){ alert("✍️ Escribe el nombre del anfitrión — no se guardan números sin nombre."); return; } if(soloDigitos(d.anfitrion_telefono).length<10){ alert("📞 Debes ingresar el teléfono del anfitrión (al menos 10 dígitos) para guardar."); return; } const refsSin=(d.referidos||[]).some(r=>soloDigitos(r.telefono).length>=10 && !(r.nombre||"").trim()); if(refsSin){ alert("✍️ Hay referidos con teléfono pero SIN nombre — ponles nombre o quita el número."); return; } onSave(d);}}>
      <Field label="Nombre del Anfitrión" required><input className={inpLight} value={d.anfitrion} onChange={e=>set("anfitrion",e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Teléfono anfitrión"><input className={inpLight} value={d.anfitrion_telefono||""} onChange={e=>set("anfitrion_telefono",e.target.value)} /></Field>
        <Field label="Ciudad"><input className={inpLight} placeholder="ej. Temple, Waco…" value={d.anfitrion_ciudad||""} onChange={e=>set("anfitrion_ciudad",e.target.value)} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Cuenta #"><input className={inpLight} value={d.anfitrion_cuenta||""} onChange={e=>set("anfitrion_cuenta",e.target.value)} /></Field>
        <Field label="Detalle"><input className={inpLight} value={d.anfitrion_detalle||""} onChange={e=>set("anfitrion_detalle",e.target.value)} /></Field>
      </div>
      <Field label="Regalo escogido"><input className={inpLight} value={d.regalo} onChange={e=>set("regalo",e.target.value)} /></Field>
      <div className="mt-4 mb-2 text-xs font-bold text-[#5b21b6] uppercase tracking-wider">Referidos</div>
      {d.referidos.map((r,i)=>(
        <div key={i} className="bg-[#f4f6f9] rounded-xl p-3 mb-3 border border-[#e5def4]">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-bold text-[#7c3aed]">Referido #{i+1}</div>
            {d.referidos.length>1 && <button type="button" onClick={()=>set("referidos",d.referidos.filter((_,j)=>j!==i))} className="text-xs text-red-400 font-bold"><Ico e="✕" className="mr-1.5" />Quitar</button>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Nombre"><input className={inpLight} value={r.nombre} onChange={e=>{const rs=[...d.referidos];rs[i]={...rs[i],nombre:e.target.value};set("referidos",rs);}}/></Field>
            <Field label="Parentesco"><input className={inpLight} placeholder="ej. Hermana, Vecino…" value={r.parentesco||""} onChange={e=>{const rs=[...d.referidos];rs[i]={...rs[i],parentesco:e.target.value};set("referidos",rs);}}/></Field>
          </div>
          <Field label="Teléfono"><input className={inpLight} value={r.telefono} onChange={e=>{const rs=[...d.referidos];rs[i]={...rs[i],telefono:e.target.value};set("referidos",rs);}}/></Field>
          <Field label="Dirección"><input className={inpLight} value={r.direccion} onChange={e=>{const rs=[...d.referidos];rs[i]={...rs[i],direccion:e.target.value};set("referidos",rs);}}/></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Ciudad"><input className={inpLight} placeholder="ej. Temple, Dallas…" value={r.ciudad||""} onChange={e=>{const rs=[...d.referidos];rs[i]={...rs[i],ciudad:e.target.value};set("referidos",rs);}}/></Field>
            <Field label="Código postal"><input className={inpLight} placeholder="ej. 76501" inputMode="numeric" maxLength={5} value={r.cp||""} onChange={e=>{const rs=[...d.referidos];rs[i]={...rs[i],cp:e.target.value.replace(/\D/g,"").slice(0,5)};set("referidos",rs);}}/></Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Producto"><input className={inpLight} placeholder="ej. Juego Innové…" value={r.producto} onChange={e=>{const rs=[...d.referidos];rs[i]={...rs[i],producto:e.target.value};set("referidos",rs);}}/></Field>
            <Field label="Observaciones"><input className={inpLight} value={r.observaciones} onChange={e=>{const rs=[...d.referidos];rs[i]={...rs[i],observaciones:e.target.value};set("referidos",rs);}}/></Field>
          </div>
        </div>
      ))}
      <button type="button" onClick={()=>set("referidos",[...d.referidos,{nombre:"",parentesco:"",telefono:"",direccion:"",ciudad:"",cp:"",producto:"",observaciones:"",detalles:"",estado:"sin_estado",ultimaNota:"",notas:[],historial:[],proximo_seguimiento:"",creado:new Date().toISOString(),actualizado:""}])} className="text-sm text-[#7c3aed] font-bold mb-4 hover:underline">+ Agregar referido</button>
      <div className="flex gap-2 pt-2"><PrimaryBtn type="submit"><Ico e="💾" className="mr-1.5" />Guardar</PrimaryBtn><button type="button" onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-slate-500 hover:bg-[#f4f6f9]">Cancelar</button></div>
    </form>
  );

  return (
    <form onSubmit={e=>{e.preventDefault(); if(!(d.nombre||"").trim()){ alert("✍️ Escribe el nombre del cliente — no se guardan números sin nombre."); return; } if(soloDigitos(d.telefono).length<10){ alert("📞 Debes ingresar un número de teléfono válido (al menos 10 dígitos) para guardar este registro."); return; } onSave(d);}}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Nombre" required><input className={inpLight} value={d.nombre} onChange={e=>set("nombre",e.target.value)} /></Field>
        <Field label="Teléfono" required><input className={inpLight} value={d.telefono} onChange={e=>set("telefono",e.target.value)} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Cuenta #"><input className={inpLight} value={d.cuenta||""} onChange={e=>set("cuenta",e.target.value)} /></Field>
        <Field label="Producto"><input className={inpLight} placeholder="ej. Juego Innové, Filtro…" value={d.producto} onChange={e=>set("producto",e.target.value)} /></Field>
      </div>
      <Field label="Dirección"><input className={inpLight} value={d.direccion} onChange={e=>set("direccion",e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ciudad"><input className={inpLight} placeholder="ej. Temple, Waco…" value={d.ciudad||""} onChange={e=>set("ciudad",e.target.value)} /></Field>
        <Field label="Código Postal"><input className={inpLight} placeholder="ej. 76501" inputMode="numeric" maxLength={5} value={d.cp||""} onChange={e=>set("cp",e.target.value.replace(/\D/g,"").slice(0,5))} /></Field>
      </div>
      {type==="prospecto" && <Field label="Fuente del dato"><input className={inpLight} placeholder="ej. Facebook, Referido, Evento…" value={d.fuente||""} onChange={e=>set("fuente",e.target.value)} /></Field>}
      {type==="distribucion" && <Field label="Fecha última compra"><input type="date" className={inpLight} value={d.ultima_compra||""} onChange={e=>set("ultima_compra",e.target.value)} /></Field>}
      {/* ASIGNACIÓN + SEGUIMIENTO */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Asignar a">
          <select className={inpLight} value={d.asignado_a||""} onChange={e=>set("asignado_a",e.target.value)}>
            <option value="">Sin asignar</option>
            {AGENTES.map(a=><option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Próximo seguimiento"><input type="date" className={inpLight} value={d.proximo_seguimiento||""} onChange={e=>set("proximo_seguimiento",e.target.value)} /></Field>
      </div>
      <Field label="Observaciones del distribuidor"><textarea className={inpLight+" resize-none"} rows={2} value={d.observaciones} onChange={e=>set("observaciones",e.target.value)} /></Field>
      <Field label="Detalles adicionales"><textarea className={inpLight+" resize-none"} rows={2} value={d.detalles} onChange={e=>set("detalles",e.target.value)} /></Field>
      <div className="flex gap-2 pt-2"><PrimaryBtn type="submit"><Ico e="💾" className="mr-1.5" />Guardar</PrimaryBtn><button type="button" onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-slate-500 hover:bg-[#f4f6f9]">Cancelar</button></div>
    </form>
  );
}

// ─── APPOINTMENT FORM (4 tipos con campos dinámicos) ──────────
const TYPE_OPTIONS = [
  { v:"cita",     ico:"📋", l:"Cita",         desc:"Azul · Google Calendar",    color:"#5b21b6", pill:"bg-purple-100 text-purple-800"    },
  { v:"llamada",  ico:"📞", l:"Recordatorio", desc:"Naranja · Google Calendar",  color:"#ea580c", pill:"bg-orange-100 text-orange-800"},
  { v:"cocinada", ico:"🍳", l:"Cocinada",     desc:"Morado · Google Calendar",   color:"#7c3aed", pill:"bg-purple-100 text-purple-800"},
  { v:"servicio", ico:"🔧", l:"Servicio",     desc:"Rojo · Google Calendar",     color:"#dc2626", pill:"bg-red-100 text-red-800"      },
  { v:"personal", ico:"🟢", l:"Personal",     desc:"Verde · Google Calendar",    color:"#16a34a", pill:"bg-green-100 text-green-800"  },
  { v:"entrevista",ico:"🤝", l:"Entrevista",   desc:"Teal · Reclutamiento",       color:"#0d9488", pill:"bg-teal-100 text-teal-800"   },
];

// ── Correos del equipo — edita aquí si cambian ──────────────
const TEAM_CONTACTS = [
  { ico:"👑", label:"Tomas (Admin)",     email:"florestomas323@gmail.com",          default:{ cita:true,  llamada:false, cocinada:true,  servicio:true,  entrevista:true } },
  { ico:"📞", label:"Angiemar Paredes",   email:"paredesangiemar@gmail.com",        default:{ cita:true,  llamada:true,  cocinada:true,  servicio:true,  entrevista:true } },
];

function AppointmentForm({ client, onSave, onClose, loading, forceTipo, agenteActivo="" }) {
  const today = new Date().toISOString().slice(0,16);

  // Build default attendees based on event type
  const buildDefaultAttendees = (tipo) =>
    TEAM_CONTACTS.filter(c => c.default[tipo||"cita"]).map(c => c.email);

  const [d, setD] = useState({
    nombre:client?.nombre||"", telefono:client?.telefono||"",
    direccion:client?.direccion||"", ciudad:client?.ciudad||"", cp:client?.cp||"",
    producto:client?.producto||"",
    cuenta:client?.cuenta||"", agente:agenteActivo||"", fecha:today, notas:"",
    tipo:forceTipo||"cita",
    invitados:["",""],
    attendees: buildDefaultAttendees(forceTipo||"cita"),
    extraEmail:"",
  });
  const set=(k,v)=>setD(p=>({...p,[k]:v}));
  const cfg = TYPE_OPTIONS.find(t=>t.v===d.tipo) || (d.tipo==="reset"?{v:"reset",ico:"🔄", l:"Re-agendar cita",desc:"Naranja · Google Calendar",color:"#f59e0b",pill:"bg-amber-100 text-amber-800"}:TYPE_OPTIONS[0]);

  // When tipo changes, reset attendees to defaults for new type
  const changeTipo = (tipo) => {
    setD(p=>({...p, tipo, attendees: buildDefaultAttendees(tipo) }));
  };

  const toggleAttendee = (email) => {
    setD(p=>({...p,
      attendees: p.attendees.includes(email)
        ? p.attendees.filter(e=>e!==email)
        : [...p.attendees, email]
    }));
  };

  const addExtra = () => {
    const em = d.extraEmail.trim().toLowerCase();
    if (!em || !em.includes("@")) return;
    if (!d.attendees.includes(em)) setD(p=>({...p, attendees:[...p.attendees,em], extraEmail:""}));
    else setD(p=>({...p, extraEmail:""}));
  };

  const removeAttendee = (email) => {
    // only allow removing non-team emails freely; team ones toggle
    setD(p=>({...p, attendees:p.attendees.filter(e=>e!==email)}));
  };

  return (
    <form onSubmit={e=>{e.preventDefault();onSave(d);}}>
      {/* TYPE SELECTOR */}
      {!forceTipo && (
        <div className="mb-4">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Tipo de evento</div>
          <div className="grid grid-cols-2 gap-2">
            {TYPE_OPTIONS.map(o=>(
              <button key={o.v} type="button" onClick={()=>changeTipo(o.v)}
                className={`flex flex-col gap-0.5 p-3 rounded-xl border-2 text-left transition ${d.tipo===o.v?"border-current":""}`}
                style={d.tipo===o.v?{borderColor:o.color,background:o.color+"12"}:{borderColor:"#e5def4"}}>
                <span className="font-black text-sm" style={d.tipo===o.v?{color:o.color}:{color:"#1f2d3d"}}>{o.l}</span>
                <span className="text-[10px] text-slate-400">{o.desc}</span>
              </button>
            ))}
          </div>
          <div className={`mt-2 text-xs font-bold px-3 py-1.5 rounded-lg inline-block ${cfg.pill}`}>{cfg.l} guardará en Calendar</div>
        </div>
      )}
      {forceTipo && (
        <div className="mb-4 rounded-xl p-3 text-sm font-bold text-white" style={{background:cfg.color}}>
          {cfg.l} — se guardará en Google Calendar
        </div>
      )}

      {/* PERSONAL: solo descripción, dirección y detalles (simple) */}
      {d.tipo==="personal" ? (
        <>
          <Field label="Descripción" required>
            <input className={inpLight} value={d.nombre} onChange={e=>set("nombre",e.target.value)} placeholder="ej. Cita médica, Gimnasio, Banco…" />
          </Field>
          <Field label="Dirección"><AddressAutocomplete value={d.direccion} onChange={v=>set("direccion",v)} onSelect={({direccion,ciudad,cp})=>setD(p=>({...p,direccion,ciudad:ciudad||p.ciudad,cp:cp||p.cp}))} placeholder="opcional" /></Field>
          <Field label="Detalles"><textarea className={inpLight+" resize-none"} rows={2} value={d.notas} onChange={e=>set("notas",e.target.value)} placeholder="detalles adicionales (opcional)" /></Field>
          <div className="grid grid-cols-1 gap-3">
            <Field label="Fecha y hora" required><input type="datetime-local" className={inpLight} value={d.fecha} onChange={e=>set("fecha",e.target.value)} /></Field>
          </div>
        </>
      ) : (
      <>
      {/* COMMON FIELDS */}
      <div className="grid grid-cols-2 gap-3">
        <Field label={d.tipo==="cocinada"?"Nombre anfitrión":"Nombre cliente"} required>
          <input className={inpLight} value={d.nombre} onChange={e=>set("nombre",e.target.value)} />
        </Field>
        <Field label="Teléfono"><input className={inpLight} value={d.telefono} onChange={e=>set("telefono",e.target.value)} /></Field>
      </div>
      <Field label="Dirección"><AddressAutocomplete value={d.direccion} onChange={v=>set("direccion",v)} onSelect={({direccion,ciudad,cp})=>setD(p=>({...p,direccion,ciudad:ciudad||p.ciudad,cp:cp||p.cp}))} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ciudad"><input className={inpLight} value={d.ciudad||""} onChange={e=>set("ciudad",e.target.value)} placeholder="ej. Temple, Dallas…" /></Field>
        <Field label="Código postal"><input className={inpLight} value={d.cp||""} onChange={e=>set("cp",e.target.value)} placeholder="ej. 76501" /></Field>
      </div>

      {/* SERVICIO: cuenta # */}
      {d.tipo==="servicio" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Producto / Servicio"><input className={inpLight} placeholder="ej. Filtro, Cookware…" value={d.producto} onChange={e=>set("producto",e.target.value)} /></Field>
          <Field label="Número de cuenta" required><input className={inpLight} value={d.cuenta} onChange={e=>set("cuenta",e.target.value)} /></Field>
        </div>
      )}
      {d.tipo!=="servicio" && (
        <Field label="Producto"><input className={inpLight} placeholder="ej. Juego Innové…" value={d.producto} onChange={e=>set("producto",e.target.value)} /></Field>
      )}

      {/* COCINADA: invitados */}
      {d.tipo==="cocinada" && (
        <div className="mb-3">
          <div className="text-xs font-bold text-purple-700 uppercase tracking-wider mb-2">Invitados</div>
          <div className="space-y-2">
            {d.invitados.map((inv,i)=>(
              <div key={i} className="flex gap-2 items-center">
                <input className={inpLight+" flex-1"} placeholder={`Invitado ${i+1}`} value={inv}
                  onChange={e=>{const arr=[...d.invitados];arr[i]=e.target.value;set("invitados",arr);}} />
                {d.invitados.length>2 && (
                  <button type="button" onClick={()=>set("invitados",d.invitados.filter((_,j)=>j!==i))}
                    className="text-red-400 font-bold text-lg px-1"><Ico e="✕" /></button>
                )}
              </div>
            ))}
          </div>
          <button type="button" onClick={()=>set("invitados",[...d.invitados,""])}
            className="mt-2 text-xs text-purple-600 font-bold hover:underline">+ Agregar invitado</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Fecha y hora" required><input type="datetime-local" className={inpLight} value={d.fecha} onChange={e=>set("fecha",e.target.value)} /></Field>
        <Field label="Vendedor/a"><input className={inpLight} placeholder="quién atiende" value={d.agente} onChange={e=>set("agente",e.target.value)} /></Field>
      </div>
      <Field label="Notas"><textarea className={inpLight+" resize-none"} rows={2} value={d.notas} onChange={e=>set("notas",e.target.value)} /></Field>
      </>
      )}

      {/* ── ATTENDEES SECTION ── */}
      <div className="mb-4 mt-1">
        <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
          <Ico e="📨" className="mr-1.5" />Notificar en Google Calendar
        </div>

        {/* Team checkboxes */}
        <div className="space-y-2 mb-3">
          {TEAM_CONTACTS.map(tc=>{
            const on = d.attendees.includes(tc.email);
            return (
              <label key={tc.email} onClick={()=>toggleAttendee(tc.email)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 cursor-pointer transition select-none ${on?"border-[#5b21b6] bg-[#5b21b6]/5":"border-[#e8edf3] bg-white hover:border-[#e5def4]"}`}>
                <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition ${on?"border-[#5b21b6] bg-[#5b21b6]":"border-[#e5def4] bg-white"}`}>
                  {on && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7"/></svg>}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-[#1f2d3d] leading-tight">{tc.label}</div>
                  <div className="text-xs text-slate-400 truncate">{tc.email}</div>
                </div>
                {on && <span className="text-[10px] font-bold text-[#5b21b6] bg-[#5b21b6]/10 px-2 py-0.5 rounded-full shrink-0"><Ico e="✓" className="mr-1.5" />Invitado</span>}
              </label>
            );
          })}
        </div>

        {/* Extra email add */}
        <div className="flex gap-2">
          <input className={inpLight+" flex-1 text-xs"} type="email"
            placeholder="Agregar otro correo…"
            value={d.extraEmail} onChange={e=>set("extraEmail",e.target.value)}
            onKeyDown={e=>{ if(e.key==="Enter"){e.preventDefault();addExtra();} }} />
          <button type="button" onClick={addExtra}
            className="px-3 py-2 rounded-lg text-xs font-bold text-white shrink-0 hover:brightness-110"
            style={{background:RP.navy}}>+ Add</button>
        </div>

        {/* Extra (non-team) attendees */}
        {d.attendees.filter(e=>!TEAM_CONTACTS.map(t=>t.email).includes(e)).length>0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {d.attendees.filter(e=>!TEAM_CONTACTS.map(t=>t.email).includes(e)).map(e=>(
              <span key={e} className="inline-flex items-center gap-1 bg-[#f4f6f9] text-[#1f2d3d] text-xs font-bold px-2.5 py-1 rounded-full border border-[#e5def4]">
                <Ico e="✉" className="mr-1.5" />{e}
                <button type="button" onClick={()=>removeAttendee(e)} className="text-red-400 ml-1 hover:text-red-600 font-bold"><Ico e="✕" /></button>
              </span>
            ))}
          </div>
        )}

        {/* Summary */}
        {d.attendees.length>0 && (
          <div className="mt-2 text-xs text-slate-400">
            Se enviará invitación a {d.attendees.length} persona(s)
          </div>
        )}
      </div>

      <div className="flex gap-2 pt-1">
        <button type="submit" disabled={loading} className="flex-1 px-4 py-2.5 rounded-lg text-sm font-bold text-white hover:brightness-110 disabled:opacity-50"
          style={{background:cfg.color}}>{loading?<><Ico e="⏳" className="mr-1" />Guardando…</>:<><Ico e="📅" className="mr-1" />Guardar en Google Calendar</>}</button>
        <button type="button" onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-slate-500 hover:bg-[#f4f6f9]">Cancelar</button>
      </div>
    </form>
  );
}

const EVENT_CONFIG = {
  cita:        { emoji:"📋", label:"Cita",                    colorId:"7",  title: n=>`📋 Cita - ${n}` },         // azul (pavo real)
  llamada:     { emoji:"📞", label:"Recordatorio",            colorId:"6",  title: n=>`📞 Recordatorio - ${n}` }, // naranja (mandarina)
  cocinada:    { emoji:"🍳", label:"Cocinada",                colorId:"3",  title: n=>`🍳 Cocinada - ${n}` },     // morado (uva)
  servicio:    { emoji:"🔧", label:"Servicio",                colorId:"11", title: n=>`🔧 Servicio - ${n}` },     // rojo (tomate)
  seguimiento: { emoji:"📅", label:"Seguimiento",             colorId:"6",  title: n=>`📅 Seguimiento - ${n}` },  // naranja (mandarina)
  reset:       { emoji:"🔄", label:"Re-agendar cita",         colorId:"6",  title: n=>`🔄 Re-agendar - ${n}` },   // naranja (mandarina)
  recordatorio:{ emoji:"🔔", label:"Recordatorio especial",   colorId:"6",  title: n=>`🔔 Recordatorio - ${n}` }, // naranja (mandarina)
  pendiente:   { emoji:"⏳", label:"Pendiente por llamar",    colorId:"6",  title: n=>`⏳ Pendiente - ${n}` },    // naranja (mandarina)
  personal:    { emoji:"🟢", label:"Personal",                colorId:"10", title: n=>`🟢 Personal - ${n}` },     // verde (albahaca)
  entrevista:  { emoji:"🤝", label:"Entrevista",              colorId:"9",  title: n=>`🤝 Entrevista - ${n}` },  // azul (arándano)
};
async function createCalendarEvent(appt) {
  const start  = new Date(appt.fecha);
  const end    = new Date(start.getTime() + 3600000);
  const cfg    = EVENT_CONFIG[appt.tipo] || EVENT_CONFIG.cita;
  const guestList   = (appt.invitados||[]).filter(Boolean).join(", ");
  // All attendees selected in the form
  const attendeeList = (appt.attendees||[]).filter(Boolean);
  const attendeeLine = attendeeList.length
    ? `Asistentes (enviar invitación a): ${attendeeList.join(", ")}`
    : "Asistente: paredesangiemar@gmail.com";
  try {
    const resp = await fetch("/api/anthropic", {
      method:"POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model:"claude-sonnet-4-5", max_tokens:1000,
        system:"Agendas eventos en Google Calendar. Cuando te pidan crear un evento con múltiples asistentes, agrégalos todos como attendees/invitados al evento.",
        messages:[{role:"user", content:`Crea evento en Google Calendar:
Título: ${cfg.title(appt.nombre)}
Inicio: ${start.toISOString()} | Fin: ${end.toISOString()}
Timezone: America/Chicago
${attendeeLine}
Descripción: Tel: ${appt.telefono} | Producto: ${appt.producto} | Dir: ${appt.direccion} | Notas: ${appt.notas} | Vendedor: ${appt.agente}${appt.cuenta?` | Cuenta: ${appt.cuenta}`:""}${guestList?` | Invitados cocinada: ${guestList}`:""}
ColorId: ${cfg.colorId}
Por favor agrega a TODOS los correos de la lista como attendees del evento.`}],
        mcp_servers:[{type:"url", url:"https://calendarmcp.googleapis.com/mcp/v1", name:"google-calendar"}]
      })
    });
    await resp.json(); return true;
  } catch { return false; }
}

// ─── AI EXTRACTOR ─────────────────────────────────────────────
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  IMPORTADOR MASIVO  \u00b7  CSV y PDF  \u00b7  SIN IA, sin costo de API
//  ---------------------------------------------------------------
//  \u00b7 CSV: se lee entero en el propio tel\u00e9fono.
//  \u00b7 PDF de texto: se extrae el texto con sus coordenadas y se
//    reconstruyen las filas y columnas de la tabla.
//  \u00b7 PDF escaneado (solo im\u00e1genes): no hay texto que leer \u2014 se avisa
//    y se sugiere el importador con IA, que s\u00ed puede verlo.
//  El CANAL (agregado / distribuci\u00f3n / referido / prospecto) puede
//  venir en una columna: cada fila se guarda donde le toca.
//  Las columnas que no se mapean NO se pierden: se guardan en
//  "otros detalles" con su nombre original.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

// Divide una l\u00ednea de CSV respetando comillas y el separador detectado.
function partirLineaCSV(linea, sep){
  const out=[]; let campo=""; let enComillas=false;
  for(let i=0;i<linea.length;i++){
    const c=linea[i];
    if(enComillas){
      if(c==='"'){ if(linea[i+1]==='"'){ campo+='"'; i++; } else enComillas=false; }
      else campo+=c;
    } else {
      if(c==='"') enComillas=true;
      else if(c===sep){ out.push(campo); campo=""; }
      else campo+=c;
    }
  }
  out.push(campo);
  return out.map(x=>x.trim());
}

// Texto CSV \u2192 { columnas, filas }
function leerCSV(texto){
  let t=String(texto||"").replace(/^\uFEFF/,"").replace(/\r\n/g,"\n").replace(/\r/g,"\n");
  const primera=t.split("\n")[0]||"";
  const cand=[",",";","\t","|"];
  let sep=","; let mejor=-1;
  cand.forEach(c=>{ const n=partirLineaCSV(primera,c).length; if(n>mejor){ mejor=n; sep=c; } });
  // Une l\u00edneas partidas por saltos dentro de comillas
  const lineas=[]; let actual=""; let comillas=0;
  t.split("\n").forEach(l=>{
    const n=(l.match(/"/g)||[]).length;
    actual = actual ? actual+"\n"+l : l;
    comillas+=n;
    if(comillas%2===0){ lineas.push(actual); actual=""; comillas=0; }
  });
  if(actual) lineas.push(actual);
  const utiles=lineas.filter(l=>l.trim()!=="");
  if(!utiles.length) return { columnas:[], filas:[], sep };
  const columnas=nombrarColumnas(partirLineaCSV(utiles[0],sep));
  const filas=utiles.slice(1).map(l=>{
    const celdas=partirLineaCSV(l,sep);
    const o={}; columnas.forEach((c,i)=>{ o[c]= celdas[i]!==undefined ? celdas[i] : ""; });
    return o;
  }).filter(f=>Object.values(f).some(v=>String(v).trim()!==""));
  return { columnas, filas, sep };
}

// Evita columnas vac\u00edas o repetidas (romper\u00edan el mapeo).
function nombrarColumnas(brutas){
  const vistas={}; 
  return (brutas||[]).map((c,i)=>{
    let n=String(c||"").trim() || `Columna ${i+1}`;
    if(vistas[n]!==undefined){ vistas[n]++; n=`${n} (${vistas[n]})`; } else vistas[n]=1;
    return n;
  });
}

// \u2500\u2500\u2500 PDF \u2192 filas de tabla \u2500\u2500\u2500
// pdf.js entrega cada trozo de texto con su posici\u00f3n (x,y). Agrupamos por
// altura para formar filas, y ordenamos por x para formar las columnas.
async function leerPDF(arrayBuffer, onProgreso){
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const filasCrudas=[];
  for(let np=1; np<=doc.numPages; np++){
    if(onProgreso) onProgreso(np, doc.numPages);
    const pagina = await doc.getPage(np);
    const contenido = await pagina.getTextContent();
    const piezas = contenido.items
      .filter(it => it && typeof it.str === "string" && it.str.trim() !== "")
      .map(it => ({ t: it.str.trim(), x: it.transform[4], y: it.transform[5] }));
    // Agrupar por l\u00ednea: misma "y" con tolerancia (el texto de una fila
    // rara vez queda exactamente a la misma altura).
    const lineas=[];
    piezas.forEach(pz=>{
      const l = lineas.find(L => Math.abs(L.y - pz.y) <= 3.2);
      if(l){ l.piezas.push(pz); l.y=(l.y*l.piezas.length + pz.y)/(l.piezas.length+1); }
      else lineas.push({ y: pz.y, piezas:[pz] });
    });
    lineas.sort((a,b)=> b.y - a.y);   // en PDF la y crece hacia arriba
    lineas.forEach(L=>{
      L.piezas.sort((a,b)=> a.x - b.x);
      // Unir trozos muy pegados (una misma palabra partida por el PDF)
      const celdas=[]; let acc=null;
      L.piezas.forEach(pz=>{
        if(acc && (pz.x - acc.xFin) < 6){ acc.t += (pz.x - acc.xFin > 1 ? " " : "") + pz.t; acc.xFin = pz.x + pz.t.length*4.2; }
        else { if(acc) celdas.push(acc); acc={ t:pz.t, x:pz.x, xFin: pz.x + pz.t.length*4.2 }; }
      });
      if(acc) celdas.push(acc);
      if(celdas.length) filasCrudas.push(celdas.map(c=>c.t));
    });
  }
  return filasCrudas;
}

// Campos del CRM a los que se puede mapear una columna.
const CAMPOS_IMP = [
  { k:"",              l:"\u2014 Otros detalles \u2014" },
  { k:"nombre",        l:"Nombre" },
  { k:"apellido",      l:"Apellido" },
  { k:"canal",         l:"CANAL (agregado/distrib/ref/prosp)" },
  { k:"cuenta",        l:"N\u00famero de cuenta" },
  { k:"telefono",      l:"Tel\u00e9fono" },
  { k:"telefonoMovil", l:"Tel\u00e9fono m\u00f3vil" },
  { k:"telefonoCasa",  l:"Tel\u00e9fono casa" },
  { k:"telefonoTrabajo",l:"Tel\u00e9fono trabajo" },
  { k:"direccion",     l:"Direcci\u00f3n" },
  { k:"ciudad",        l:"Ciudad" },
  { k:"cp",            l:"C\u00f3digo postal" },
  { k:"producto",      l:"Producto" },
  { k:"vendedor",      l:"Vendedor" },
  { k:"anfitrion",     l:"Anfitri\u00f3n (para referidos)" },
  { k:"nivelCliente",  l:"Nivel de cliente" },
  { k:"limiteCredito", l:"L\u00edmite de cr\u00e9dito" },
  { k:"saldoActual",   l:"Saldo actual" },
  { k:"fuente",        l:"Fuente" },
  { k:"ultima_compra", l:"\u00daltima compra" },
  { k:"observaciones", l:"Observaciones" },
  { k:"omitir",        l:"\u2715 No importar" },
];

// Adivina el campo por el nombre de la columna.
function adivinarCampo(nombreCol){
  const t=String(nombreCol||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
  const tiene=(...ps)=>ps.some(x=>t.includes(x));
  if(tiene("canal","seccion","secci\u00f3n","tipo de cliente","categoria","base")) return "canal";
  if(tiene("anfitrion","host","quien refiere","refiere")) return "anfitrion";
  if(tiene("apellido","last name","surname")) return "apellido";
  if(tiene("movil","celular","cell","mobile")) return "telefonoMovil";
  if(tiene("casa","home")&&tiene("tel","phone")) return "telefonoCasa";
  if(tiene("trabajo","work","oficina")&&tiene("tel","phone")) return "telefonoTrabajo";
  if(tiene("telefono","phone","tel.","numero de tel","contacto")) return "telefono";
  if(tiene("cuenta","account","acct","no. cta","nro cta")) return "cuenta";
  if(tiene("nombre","name","cliente","customer")) return "nombre";
  if(tiene("direccion","address","domicilio","calle")) return "direccion";
  if(tiene("ciudad","city","municipio")) return "ciudad";
  if(tiene("postal","zip","c.p")) return "cp";
  if(tiene("producto","product","articulo")) return "producto";
  if(tiene("vendedor","seller","asesor")) return "vendedor";
  if(tiene("nivel","level")) return "nivelCliente";
  if(tiene("limite")) return "limiteCredito";
  if(tiene("saldo","balance","deuda")) return "saldoActual";
  if(tiene("fuente","source","origen")) return "fuente";
  if(tiene("ultima compra","last purchase")) return "ultima_compra";
  if(tiene("observacion","nota","note","comment","detalle")) return "observaciones";
  return "";
}

// Texto del canal \u2192 secci\u00f3n real de la app.
function canalASeccion(valor){
  const t=String(valor||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
  if(!t) return null;
  if(t.includes("refer")) return "referidos";
  if(t.includes("distrib") || t.includes("reparto")) return "distribucion";
  if(t.includes("prospec") || t.includes("prospect")) return "prospectos";
  if(t.includes("agregad") || t.includes("cliente") || t.includes("added")) return "agregados";
  return null;
}
const SEC_NOMBRE = { agregados:"Clientes (Agregados)", prospectos:"Prospecci\u00f3n", distribucion:"Distribuci\u00f3n", referidos:"Referidos" };

function ImportadorMasivo({ onListo, onClose }){
  const [paso,setPaso]=useState(1);
  const [nombreArch,setNombreArch]=useState("");
  const [columnas,setColumnas]=useState([]);
  const [filas,setFilas]=useState([]);
  const [mapa,setMapa]=useState({});
  const [destDefecto,setDestDefecto]=useState("agregados");
  const [error,setError]=useState("");
  const [cargando,setCargando]=useState("");
  const [pdfCrudo,setPdfCrudo]=useState(null);   // filas del PDF antes de elegir encabezado
  const [filaEncab,setFilaEncab]=useState(0);
  const fileRef=useRef(null);

  const prepararTabla=(cols,fs,nombre)=>{
    const m={}; cols.forEach(c=>{ m[c]=adivinarCampo(c); });
    setColumnas(cols); setFilas(fs); setMapa(m); setNombreArch(nombre);
    setError(""); setCargando(""); setPaso(2);
  };

  const alElegirArchivo=async (e)=>{
    const f=e.target.files&&e.target.files[0];
    if(!f) return;
    setError(""); setPdfCrudo(null);
    if(/\.xlsx?$/i.test(f.name)){
      setError("Los archivos de Excel (.xls/.xlsx) no se leen directo. \u00c1brelo en Excel o Numbers \u2192 Exportar \u2192 CSV, y sube ese archivo.");
      return;
    }
    if(/\.pdf$/i.test(f.name) || f.type==="application/pdf"){
      try{
        setCargando("Leyendo PDF\u2026");
        const buf=await f.arrayBuffer();
        const crudas=await leerPDF(buf,(n,total)=>setCargando(`Leyendo PDF\u2026 p\u00e1gina ${n} de ${total}`));
        if(!crudas.length){
          setCargando("");
          setError("Este PDF no tiene texto \u2014 es un escaneo o una foto. Para leerlo usa el bot\u00f3n \u00abImportar con IA\u00bb, que s\u00ed puede verlo.");
          return;
        }
        setPdfCrudo(crudas); setNombreArch(f.name); setFilaEncab(0);
        setCargando(""); setPaso(1.5);
      }catch(err){
        setCargando("");
        setError("No se pudo leer el PDF: "+(err&&err.message?err.message:"error"));
      }
      return;
    }
    const lector=new FileReader();
    lector.onload=()=>{
      try{
        const { columnas:cols, filas:fs } = leerCSV(String(lector.result||""));
        if(!cols.length || !fs.length){ setError("No se encontraron filas con datos. \u00bfEl archivo tiene encabezados en la primera fila?"); return; }
        prepararTabla(cols,fs,f.name);
      }catch(err){ setError("No se pudo leer el archivo: "+(err&&err.message?err.message:"error")); }
    };
    lector.onerror=()=>setError("No se pudo abrir el archivo.");
    lector.readAsText(f,"UTF-8");
  };

  // Confirmar cu\u00e1l fila del PDF es el encabezado y armar la tabla.
  const confirmarEncabezadoPDF=()=>{
    const cols=nombrarColumnas(pdfCrudo[filaEncab]||[]);
    const cuerpo=pdfCrudo.slice(filaEncab+1)
      .filter(r=>r.length>1)
      .map(r=>{ const o={}; cols.forEach((c,i)=>{ o[c]= r[i]!==undefined ? r[i] : ""; }); return o; })
      .filter(f=>Object.values(f).some(v=>String(v).trim()!==""));
    if(!cuerpo.length){ setError("Con esa fila como encabezado no quedaron datos. Prueba con otra."); return; }
    prepararTabla(cols,cuerpo,nombreArch);
  };

  // Construye los registros finales, agrupados por canal.
  const construir=()=>{
    const porSeccion={ agregados:[], prospectos:[], distribucion:[], referidos:[] };
    filas.forEach(f=>{
      const r={}; const extras=[];
      let apellido="", canalTxt="", anfitrion="";
      columnas.forEach(c=>{
        const campo=mapa[c];
        const val=String(f[c]==null?"":f[c]).trim();
        if(!val || campo==="omitir") return;
        if(campo==="apellido"){ apellido=val; return; }
        if(campo==="canal"){ canalTxt=val; return; }
        if(campo==="anfitrion"){ anfitrion=val; return; }
        if(!campo){ extras.push(`${c}: ${val}`); return; }   // nada se pierde
        r[campo]= r[campo] ? `${r[campo]} / ${val}` : val;
      });
      // Nombre + apellido se unen con un espacio (no con barra).
      if(apellido) r.nombre = r.nombre ? `${r.nombre} ${apellido}` : apellido;
      if(extras.length) r.otrosDetalles = r.otrosDetalles ? `${r.otrosDetalles} \u00b7 ${extras.join(" \u00b7 ")}` : extras.join(" \u00b7 ");
      if(!r.telefono && r.telefonoMovil) r.telefono=r.telefonoMovil;
      if(!r.telefono && r.telefonoCasa)  r.telefono=r.telefonoCasa;
      const tieneAlgo = (r.nombre&&r.nombre.trim()) || (r.telefono&&r.telefono.trim()) || (r.cuenta&&r.cuenta.trim());
      if(!tieneAlgo) return;
      const sec = canalASeccion(canalTxt) || (anfitrion ? "referidos" : destDefecto);
      if(sec==="referidos") porSeccion.referidos.push({ ...r, _anfitrion: anfitrion });
      else porSeccion[sec].push(r);
    });
    return porSeccion;
  };

  const grupos = paso>=2 ? construir() : { agregados:[], prospectos:[], distribucion:[], referidos:[] };
  const totalListos = Object.values(grupos).reduce((a,l)=>a+l.length,0);
  const hayCanal = Object.values(mapa).includes("canal");
  const hayContacto = Object.values(mapa).some(v=> v==="nombre"||v==="apellido"||v==="cuenta"||(v&&v.indexOf("telefono")===0));

  return (
    <div className="space-y-3">
      {error && <div className="text-xs font-bold text-red-500 bg-red-50 border border-red-200 rounded-xl px-3 py-2 leading-relaxed">{error}</div>}
      {cargando && <div className="text-xs font-bold text-[#5b21b6] bg-[#f1ecfd] rounded-xl px-3 py-2">{cargando}</div>}

      {paso===1 && (
        <>
          <div className="text-sm text-slate-600 leading-relaxed">
            Sube un <b>CSV</b> o un <b>PDF con texto</b>. Se lee aqu\u00ed mismo, en tu tel\u00e9fono \u2014 sin usar inteligencia artificial y sin costo.
          </div>
          <input ref={fileRef} type="file" accept=".csv,.pdf,text/csv,text/plain,application/pdf" onChange={alElegirArchivo} className="hidden" />
          <button onClick={()=>fileRef.current&&fileRef.current.click()}
            className="w-full py-4 rounded-2xl font-black text-white text-sm active:scale-95 transition" style={{background:RP.navy}}>
            <Ico e="\U0001F4C4" className="mr-1.5" />Elegir archivo (CSV o PDF)
          </button>
          <div className="text-[11px] text-slate-400 leading-relaxed">
            \u00b7 <b>Excel:</b> \u00e1brelo y usa Exportar \u2192 CSV.<br/>
            \u00b7 <b>PDF escaneado</b> (no se puede seleccionar su texto): usa el bot\u00f3n de IA.<br/>
            \u00b7 Si el archivo trae una columna de <b>canal</b>, cada fila se guarda en su secci\u00f3n sola.
          </div>
        </>
      )}

      {paso===1.5 && pdfCrudo && (
        <>
          <div className="text-xs font-bold text-slate-500"><Ico e="\u2705" /> {nombreArch} \u00b7 {pdfCrudo.length} l\u00edneas le\u00eddas</div>
          <div className="text-sm font-black text-[#5b21b6] uppercase tracking-wider">\u00bfCu\u00e1l fila tiene los t\u00edtulos?</div>
          <div className="text-[11px] text-slate-400">Toca la fila que contiene los nombres de las columnas (Nombre, Tel\u00e9fono\u2026). Lo de arriba suele ser el membrete del reporte.</div>
          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {pdfCrudo.slice(0,12).map((r,i)=>(
              <button key={i} onClick={()=>setFilaEncab(i)}
                className={`w-full text-left px-3 py-2 rounded-xl border-2 transition ${filaEncab===i?"border-[#7c3aed] bg-[#f1ecfd]":"border-[#e8edf3] bg-white"}`}>
                <div className="text-[11px] font-bold text-slate-600">Fila {i+1} \u00b7 {r.length} celdas</div>
                <div className="text-[11px] text-slate-500 truncate">{r.map(c=>c.t).join(" \u2502 ").slice(0,90)}</div>
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={()=>{setPaso(1);setPdfCrudo(null);}} className="px-4 py-3 rounded-xl text-xs font-bold bg-[#f4f6f9] text-slate-600">\u2190 Otro archivo</button>
            <button onClick={confirmarEncabezadoPDF} className="flex-1 py-3 rounded-xl text-sm font-black text-white" style={{background:RP.navy}}>Continuar \u203a</button>
          </div>
        </>
      )}

      {paso===2 && (
        <>
          <div className="text-xs font-bold text-slate-500"><Ico e="\u2705" /> {nombreArch} \u00b7 {filas.length.toLocaleString()} filas \u00b7 {columnas.length} columnas</div>
          <div className="text-sm font-black text-[#5b21b6] uppercase tracking-wider">\u00bfQu\u00e9 es cada columna?</div>
          <div className="text-[11px] text-slate-400 leading-relaxed">Lo que dejes en \u00abOtros detalles\u00bb igual se guarda, con el nombre de su columna.</div>
          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {columnas.map(c=>(
              <div key={c} className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold truncate">{c}</div>
                  <div className="text-[10px] text-slate-400 truncate">ej: {String((filas[0]||{})[c]||"").slice(0,26)||"(vac\u00edo)"}</div>
                </div>
                <select value={mapa[c]||""} onChange={e=>setMapa(m=>({...m,[c]:e.target.value}))}
                  className="text-xs border-2 border-[#e5def4] rounded-lg px-2 py-1.5 bg-white shrink-0" style={{maxWidth:"50%"}}>
                  {CAMPOS_IMP.map(f=><option key={f.k} value={f.k}>{f.l}</option>)}
                </select>
              </div>
            ))}
          </div>
          {!hayContacto && <div className="text-[11px] font-bold text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Marca al menos una columna como Nombre, Tel\u00e9fono o N\u00famero de cuenta.</div>}
          <div className="flex gap-2">
            <button onClick={()=>{setPaso(pdfCrudo?1.5:1);}} className="px-4 py-3 rounded-xl text-xs font-bold bg-[#f4f6f9] text-slate-600">\u2190 Atr\u00e1s</button>
            <button onClick={()=>setPaso(3)} disabled={!hayContacto} className="flex-1 py-3 rounded-xl text-sm font-black text-white disabled:opacity-50" style={{background:RP.navy}}>Continuar \u203a</button>
          </div>
        </>
      )}

      {paso===3 && (
        <>
          {!hayCanal && (
            <>
              <div className="text-sm font-black text-[#5b21b6] uppercase tracking-wider">\u00bfD\u00f3nde se guardan?</div>
              <div className="text-[11px] text-slate-400">El archivo no trae columna de canal, as\u00ed que todo va a la misma secci\u00f3n.</div>
              <div className="grid grid-cols-1 gap-2">
                {["agregados","prospectos","distribucion"].map(v=>(
                  <button key={v} onClick={()=>setDestDefecto(v)}
                    className={`text-left px-4 py-3 rounded-2xl border-2 transition ${destDefecto===v?"border-[#7c3aed] bg-[#f1ecfd]":"border-[#e8edf3] bg-white"}`}>
                    <div className="font-bold text-sm">{SEC_NOMBRE[v]}</div>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="rounded-xl bg-[#f4f6f9] p-3">
            <div className="text-xs font-black text-slate-600 mb-1.5">Se van a importar {totalListos.toLocaleString()} registros</div>
            {Object.keys(grupos).filter(k=>grupos[k].length).map(k=>(
              <div key={k} className="text-[11px] text-slate-500 flex justify-between border-t border-[#e8edf3] pt-1 mt-1">
                <span>{SEC_NOMBRE[k]}</span><b className="text-slate-700">{grupos[k].length.toLocaleString()}</b>
              </div>
            ))}
          </div>

          <div className="rounded-xl bg-[#f4f6f9] p-3">
            <div className="text-xs font-black text-slate-600 mb-1">Vista previa</div>
            {[...grupos.agregados,...grupos.prospectos,...grupos.distribucion,...grupos.referidos].slice(0,3).map((r,i)=>(
              <div key={i} className="text-[11px] text-slate-500 border-t border-[#e8edf3] pt-1.5 mt-1.5">
                <b className="text-slate-700">{r.nombre||"(sin nombre)"}</b>
                {r.telefono?` \u00b7 ${r.telefono}`:""}{r.cuenta?` \u00b7 cta ${r.cuenta}`:""}
                {r.otrosDetalles?<div className="text-slate-400 truncate">{r.otrosDetalles}</div>:null}
              </div>
            ))}
          </div>

          <div className="text-[11px] text-slate-400 leading-relaxed">
            Los repetidos se detectan solos (por cuenta, tel\u00e9fono o nombre) y se te muestran para revisar antes de guardar.
          </div>
          <div className="flex gap-2">
            <button onClick={()=>setPaso(2)} className="px-4 py-3 rounded-xl text-xs font-bold bg-[#f4f6f9] text-slate-600">\u2190 Columnas</button>
            <button onClick={()=>onListo(grupos)} disabled={!totalListos}
              className="flex-1 py-3 rounded-xl text-sm font-black text-white disabled:opacity-50" style={{background:RP.navy}}>
              Importar {totalListos.toLocaleString()}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AIExtractor({ onExtracted, onClose }) {
  const [files,setFiles]=useState([]);const [loading,setLoading]=useState(false);
  const [preview,setPreview]=useState(null);const [refPreview,setRefPreview]=useState(null);
  const [dest,setDest]=useState("agregados");const [error,setError]=useState("");const fileRef=useRef();
  const [modelo,setModelo]=useState("haiku"); // "haiku" o "sonnet"
  const [progreso,setProgreso]=useState("");
  const MODELOS={
    haiku:  { id:"claude-haiku-4-5-20251001", ico:"⚡", label:"Rápido",    desc:"Listas digitales, PDFs claros, hasta ~50 registros",    color:"#0d9488", badge:"HAIKU"  },
    sonnet: { id:"claude-sonnet-4-5",         ico:"🧠", label:"Preciso",   desc:"Fotos, letra a mano, documentos difíciles de leer",     color:"#7c3aed", badge:"SONNET" },
  };
  const handleFile=e=>{
    const nuevos=Array.from(e.target.files||[]);
    if(!nuevos.length) return;
    setFiles(prev=>{
      const combinados=[...prev,...nuevos].slice(0,20); // máximo 20
      return combinados;
    });
    setPreview(null);setRefPreview(null);setError("");
  };
  const quitarArchivo=(idx)=>setFiles(prev=>prev.filter((_,i)=>i!==idx));

  // Procesar UN archivo y devolver su base64 + media_type
  const prepararArchivo=async(file)=>{
    const b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.onerror=()=>rej(new Error("No se pudo leer el archivo"));r.readAsDataURL(file);});
    const isPdf=file.type==="application/pdf" || /\.pdf$/i.test(file.name||"");
    let mediaType=(file.type||"").toLowerCase();
    if(!isPdf){
      const name=(file.name||"").toLowerCase();
      if(mediaType==="image/jpg") mediaType="image/jpeg";
      if(!["image/jpeg","image/png","image/gif","image/webp"].includes(mediaType)){
        if(/\.(jpe?g)$/i.test(name)) mediaType="image/jpeg";
        else if(/\.png$/i.test(name)) mediaType="image/png";
        else if(/\.gif$/i.test(name)) mediaType="image/gif";
        else if(/\.webp$/i.test(name)) mediaType="image/webp";
        else if(/\.(heic|heif)$/i.test(name)){ throw new Error("El formato HEIC del iPhone no es compatible ("+file.name+"). En tu iPhone ve a Ajustes → Cámara → Formatos → 'Más compatible', o usa una captura de pantalla."); }
        else mediaType="image/jpeg";
      }
    }
    const sizeMB=(b64.length*0.75)/(1024*1024);
    if(sizeMB>4.5) throw new Error("Una imagen es muy grande ("+sizeMB.toFixed(1)+"MB: "+file.name+"). Usa una captura de pantalla o redúcela.");
    return isPdf?{type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}}:{type:"image",source:{type:"base64",media_type:mediaType,data:b64}};
  };

  // Extraer datos de UN bloque (una imagen/PDF)
  const extraerUno=async(block)=>{
    const sys=dest==="referidos"
      ? `Extrae datos de referidos para Royal Prestige. Responde SOLO JSON sin backticks. Formato: {"referidos":[{"anfitrion":"","regalo":"","referidos":[{"nombre":"","parentesco":"","telefono":"","direccion":"","producto":"","observaciones":""}]}]}`
      : `Extrae TODA la información útil de clientes del documento para Royal Prestige. Responde SOLO JSON compacto sin backticks ni explicaciones.

EXTRAE Y GUARDA SI APARECEN: nombre completo, número de cuenta, dirección, teléfono de casa, teléfono de trabajo, teléfono móvil, vendedor, nivel del cliente o nivel de financiamiento, límite de crédito, saldo actual, productos comprados (como lista simple de texto), y cualquier otro dato útil para seguimiento (en "otrosDetalles").

NUNCA extraigas ni inventes: fecha original de compra, fecha de cierre, última fecha de pago, morosidad, fecha de orden, código de artículo, descripción de artículo, cantidad. Ignóralos por completo.

NO inventes datos. Si un campo no aparece, déjalo vacío "".

Formato EXACTO: {"registros":[{"nombre":"","numeroCuenta":"","direccion":"","telefonoCasa":"","telefonoTrabajo":"","telefonoMovil":"","vendedor":"","nivelCliente":"","limiteCredito":"","saldoActual":"","productos":[],"otrosDetalles":""}]}. NO te detengas hasta incluir TODOS los clientes visibles.`;
    let resp;
    try{
      resp=await fetch("/api/anthropic",{method:"POST",headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({model:MODELOS[modelo].id,max_tokens:8000,system:sys,messages:[{role:"user",content:[block,{type:"text",text:"Extrae los datos. Solo JSON."}]}]})});
    }catch(netErr){
      throw new Error("No se pudo conectar con el servicio de IA. Revisa tu conexión a internet. Si persiste, puede que tu API key no tenga créditos.");
    }
    if(!resp.ok){
      let msg="Error "+resp.status;
      try{ const e=await resp.json(); msg=(e.error&&e.error.message)||msg; }catch{}
      if(resp.status===401) msg="API key inválida o sin créditos. Revisa tu cuenta de Anthropic.";
      if(resp.status===400) msg="Una imagen no se pudo procesar. Intenta con una captura de pantalla más clara.";
      if(resp.status===413) msg="Una imagen es muy grande. Usa captura de pantalla.";
      if(resp.status===529||resp.status===429) msg="El servicio está ocupado. Espera unos segundos e intenta de nuevo.";
      throw new Error(msg);
    }
    const data=await resp.json();
    const text=(data.content||[]).map(b=>b.text||"").join("");
    if(!text.trim()) return dest==="referidos"?{referidos:[]}:{registros:[]};
    let clean=text.replace(/```json|```/g,"").trim();
    const fb=clean.indexOf("{"); const lb=clean.lastIndexOf("}");
    if(fb>=0&&lb>fb) clean=clean.slice(fb,lb+1);
    try{ return JSON.parse(clean); }
    catch{
      const arrName = dest==="referidos" ? "referidos" : "registros";
      const objs = clean.match(/\{[^{}]*\}/g) || [];
      const recovered = objs.map(o=>{ try{return JSON.parse(o);}catch{return null;} }).filter(Boolean);
      return { [arrName]: recovered };
    }
  };

  const extract=async()=>{
    if(!files.length){setError("Primero selecciona uno o más archivos.");return;}
    setLoading(true);setError("");setProgreso("");
    try{
      let acumReg=[], acumRef=[];
      for(let i=0;i<files.length;i++){
        setProgreso(`Procesando ${i+1} de ${files.length}…`);
        const block=await prepararArchivo(files[i]);
        const parsed=await extraerUno(block);
        if(dest==="referidos") acumRef=acumRef.concat(parsed.referidos||[]);
        else acumReg=acumReg.concat(parsed.registros||[]);
      }
      setProgreso("");
      if(dest==="referidos"){
        if(!acumRef.length) throw new Error("No se encontraron referidos en los archivos.");
        setRefPreview(acumRef);
      }else{
        if(!acumReg.length) throw new Error("No se encontraron datos de contacto en los archivos.");
        setPreview(acumReg);
      }
    }catch(err){
      setError("⚠️ "+(err.message||"No se pudo extraer. Verifica los archivos e intenta de nuevo."));
      setProgreso("");
    }
    setLoading(false);
  };
  const confirm=()=>{
    if(dest==="referidos"){if(!refPreview?.length)return;
      onExtracted(refPreview.map(r=>({...emptyReferido(),anfitrion:r.anfitrion||"",regalo:r.regalo||"",
        referidos:(r.referidos||[]).map(x=>({nombre:x.nombre||"",parentesco:x.parentesco||"",telefono:x.telefono||"",direccion:x.direccion||"",producto:x.producto||"",observaciones:x.observaciones||"",detalles:"",estado:"sin_estado"})),id:genId()})),"referidos");
    }else{if(!preview?.length)return;
      // Mapear los campos nuevos de la IA al modelo del cliente
      const mapped=preview.map(r=>{
        const movil=r.telefonoMovil||r.telefono||"";
        const tel = movil || r.telefonoCasa || r.telefonoTrabajo || "";
        return {
          nombre:r.nombre||"",
          cuenta:r.numeroCuenta||r.cuenta||"",
          direccion:r.direccion||"",
          telefono:tel,                              // el principal (móvil de preferencia)
          telefonoCasa:r.telefonoCasa||"",
          telefonoTrabajo:r.telefonoTrabajo||"",
          telefonoMovil:movil,
          vendedor:r.vendedor||"",
          nivelCliente:r.nivelCliente||"",
          limiteCredito:r.limiteCredito||"",
          saldoActual:r.saldoActual||"",
          productos:Array.isArray(r.productos)?r.productos:(r.productos?[r.productos]:[]),
          otrosDetalles:r.otrosDetalles||"",
          ciudad:r.ciudad||"",
          observaciones:r.observaciones||"",
        };
      });
      onExtracted(mapped,dest);
    }
  };
  const hasPreview=dest==="referidos"?!!refPreview:!!preview;
  const count=dest==="referidos"?(refPreview?.length||0):(preview?.length||0);
  return (
    <div>
      <div className="bg-[#5b21b6]/8 border border-[#5b21b6]/15 rounded-xl p-4 mb-4 text-sm text-[#5b21b6] font-medium"><strong><Ico e="🤖" className="mr-1.5" />Extracción con IA:</strong> Sube hasta <strong>20 fotos o PDFs</strong> y la IA llena la base de datos sola.</div>

      {/* SELECTOR DE MODELO */}
      <Field label="Tipo de extracción">
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(MODELOS).map(([k,m])=>(
            <button key={k} type="button" onClick={()=>setModelo(k)}
              className={`text-left px-3 py-3 rounded-xl border-2 transition ${modelo===k?"border-2 text-white":"border-[#e5def4] bg-white text-slate-700"}`}
              style={modelo===k?{background:m.color,borderColor:m.color}:{}}>
              <div className="font-black text-sm">{m.label}</div>
              <div className={`text-[10px] mt-0.5 leading-tight ${modelo===k?"text-white/80":"text-slate-400"}`}>{m.desc}</div>
            </button>
          ))}
        </div>
        <div className="mt-2 text-[11px] text-slate-400 text-center">
          <Ico e="💡" className="mr-1.5" />Recomendado: <strong>máx. 50 datos por imagen</strong> para mejor resultado
        </div>
      </Field>
      <Field label={`Archivos (PDF, JPG, PNG) — ${files.length}/20`}>
        <div onClick={()=>fileRef.current.click()} className="border-2 border-dashed border-[#e5def4] rounded-xl p-5 text-center cursor-pointer hover:border-[#7c3aed] hover:bg-[#f4f6f9] transition">
          <div className="text-3xl mb-1">{files.length?"➕":"📎"}</div>
          <div className="text-sm text-slate-600 font-bold">{files.length?`Agregar más (${files.length} seleccionado${files.length>1?"s":""})`:"Toca para seleccionar archivos"}</div>
          <div className="text-[10px] text-slate-400 mt-1">Puedes elegir varias a la vez</div>
          <input ref={fileRef} type="file" className="hidden" accept=".pdf,image/*" multiple onChange={handleFile} />
        </div>
        {files.length>0 && (
          <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
            {files.map((f,i)=>(
              <div key={i} className="flex items-center gap-2 bg-[#f4f6f9] rounded-lg px-2.5 py-1.5 text-xs">
                <span className="shrink-0">{/\.pdf$/i.test(f.name)?"📄":"🖼️"}</span>
                <span className="flex-1 truncate text-slate-600">{f.name}</span>
                <button onClick={(e)=>{e.stopPropagation();quitarArchivo(i);}} className="text-red-400 font-bold shrink-0 px-1"><Ico e="✕" /></button>
              </div>
            ))}
          </div>
        )}
      </Field>
      <Field label="Guardar en sección">
        <div className="grid grid-cols-2 gap-2">
          {[{v:"agregados",ico:"📂", l:"Agregados"},{v:"referidos",ico:"🎁", l:"Referidos"},{v:"prospectos",ico:"🔍", l:"Prospección"},{v:"distribucion",ico:"🏠", l:"Distribución"}].map(o=>(
            <button key={o.v} type="button" onClick={()=>{setDest(o.v);setPreview(null);setRefPreview(null);}} className={`px-3 py-2.5 rounded-xl text-xs font-bold border-2 transition text-left ${dest===o.v?"border-[#5b21b6] bg-[#5b21b6]/5 text-[#5b21b6]":"border-[#e5def4] text-slate-600"}`}>{o.l}</button>
          ))}
        </div>
      </Field>
      {error && <div className="text-red-500 text-sm mb-3 bg-red-50 p-3 rounded-lg">{error}</div>}
      {!hasPreview && <PrimaryBtn onClick={extract} disabled={!files.length||loading} full>{loading?(progreso||`⏳ Extrayendo con ${MODELOS[modelo].badge}…`):`🤖 Extraer ${files.length>1?files.length+" archivos":""} con ${MODELOS[modelo].label}`}</PrimaryBtn>}
      {hasPreview && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-bold text-slate-700"><Ico e="✅" className="mr-1.5" />{count} registro(s) — Toca para editar:</div>
            {dest!=="referidos" && <button onClick={()=>setPreview(p=>[...p,{nombre:"",telefonoMovil:"",numeroCuenta:"",direccion:"",vendedor:"",nivelCliente:"",limiteCredito:"",saldoActual:"",productos:[],otrosDetalles:""}])} className="text-xs font-bold text-[#7c3aed]">+ Agregar</button>}
          </div>
          <div className="space-y-2 max-h-72 overflow-y-auto mb-4">
            {dest==="referidos"?refPreview.map((r,i)=>(
              <div key={i} className="bg-[#f4f6f9] rounded-lg p-3 border border-[#e8edf3] text-sm">
                <div className="flex items-center justify-between mb-1.5">
                  <input value={r.anfitrion||""} onChange={e=>setRefPreview(p=>p.map((x,j)=>j===i?{...x,anfitrion:e.target.value}:x))} className="font-bold text-slate-800 bg-white border border-[#e5def4] rounded px-2 py-1 text-sm flex-1 mr-2" placeholder="Anfitrión" />
                  <button onClick={()=>setRefPreview(p=>p.filter((_,j)=>j!==i))} className="text-red-400 text-xs font-bold shrink-0"><Ico e="🗑" /></button>
                </div>
                <input value={r.regalo||""} onChange={e=>setRefPreview(p=>p.map((x,j)=>j===i?{...x,regalo:e.target.value}:x))} className="w-full bg-white border border-[#e5def4] rounded px-2 py-1 text-xs text-slate-600" placeholder="Regalo" />
                <div className="text-slate-400 text-[10px] mt-1">{r.referidos?.length||0} referido(s)</div>
              </div>
            ))
            :preview.map((r,i)=>(
              <div key={i} className="bg-[#f4f6f9] rounded-lg p-3 border border-[#e8edf3] space-y-1.5">
                <div className="flex items-center gap-2">
                  <input value={r.nombre||""} onChange={e=>setPreview(p=>p.map((x,j)=>j===i?{...x,nombre:e.target.value}:x))} className="font-bold text-slate-800 bg-white border border-[#e5def4] rounded px-2 py-1 text-sm flex-1" placeholder="Nombre" />
                  <button onClick={()=>setPreview(p=>p.filter((_,j)=>j!==i))} className="text-red-400 text-xs font-bold shrink-0 px-1"><Ico e="🗑" /></button>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <input value={r.telefonoMovil||r.telefono||""} onChange={e=>setPreview(p=>p.map((x,j)=>j===i?{...x,telefonoMovil:e.target.value}:x))} className="bg-white border border-[#e5def4] rounded px-2 py-1 text-xs text-slate-600" placeholder="Móvil" />
                  <input value={r.numeroCuenta||r.cuenta||""} onChange={e=>setPreview(p=>p.map((x,j)=>j===i?{...x,numeroCuenta:e.target.value}:x))} className="bg-white border border-[#e5def4] rounded px-2 py-1 text-xs text-slate-600" placeholder="N° cuenta" />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <input value={r.telefonoCasa||""} onChange={e=>setPreview(p=>p.map((x,j)=>j===i?{...x,telefonoCasa:e.target.value}:x))} className="bg-white border border-[#e5def4] rounded px-2 py-1 text-xs text-slate-600" placeholder="Casa" />
                  <input value={r.telefonoTrabajo||""} onChange={e=>setPreview(p=>p.map((x,j)=>j===i?{...x,telefonoTrabajo:e.target.value}:x))} className="bg-white border border-[#e5def4] rounded px-2 py-1 text-xs text-slate-600" placeholder="Trabajo" />
                </div>
                <input value={r.direccion||""} onChange={e=>setPreview(p=>p.map((x,j)=>j===i?{...x,direccion:e.target.value}:x))} className="w-full bg-white border border-[#e5def4] rounded px-2 py-1 text-xs text-slate-600" placeholder="Dirección" />
                <div className="grid grid-cols-2 gap-1.5">
                  <input value={r.vendedor||""} onChange={e=>setPreview(p=>p.map((x,j)=>j===i?{...x,vendedor:e.target.value}:x))} className="bg-white border border-[#e5def4] rounded px-2 py-1 text-xs text-slate-600" placeholder="Vendedor" />
                  <input value={r.nivelCliente||""} onChange={e=>setPreview(p=>p.map((x,j)=>j===i?{...x,nivelCliente:e.target.value}:x))} className="bg-white border border-[#e5def4] rounded px-2 py-1 text-xs text-slate-600" placeholder="Nivel" />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <input value={r.limiteCredito||""} onChange={e=>setPreview(p=>p.map((x,j)=>j===i?{...x,limiteCredito:e.target.value}:x))} className="bg-white border border-[#e5def4] rounded px-2 py-1 text-xs text-slate-600" placeholder="Límite crédito" />
                  <input value={r.saldoActual||""} onChange={e=>setPreview(p=>p.map((x,j)=>j===i?{...x,saldoActual:e.target.value}:x))} className="bg-white border border-[#e5def4] rounded px-2 py-1 text-xs text-slate-600" placeholder="Saldo actual" />
                </div>
                <input value={Array.isArray(r.productos)?r.productos.join(", "):(r.productos||"")} onChange={e=>setPreview(p=>p.map((x,j)=>j===i?{...x,productos:e.target.value.split(",").map(s=>s.trim()).filter(Boolean)}:x))} className="w-full bg-white border border-[#e5def4] rounded px-2 py-1 text-xs text-slate-600" placeholder="Productos (separados por coma)" />
                <input value={r.otrosDetalles||""} onChange={e=>setPreview(p=>p.map((x,j)=>j===i?{...x,otrosDetalles:e.target.value}:x))} className="w-full bg-white border border-[#e5def4] rounded px-2 py-1 text-xs text-slate-600" placeholder="Otros detalles" />
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={confirm} className="px-4 py-2.5 rounded-lg text-sm font-bold text-white" style={{background:RP.blue}}><Ico e="✅" className="mr-1.5" />Confirmar y guardar {count}</button>
            <button onClick={()=>{setPreview(null);setRefPreview(null);setFiles([]);}} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-slate-500 hover:bg-[#f4f6f9]">Volver</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── AUTOCOMPLETAR DIRECCIÓN (Geoapify) ───────────────────────
// Campo de dirección con sugerencias reales. Al elegir una, llama
// onSelect con {direccion, ciudad, cp} para llenar los 3 campos solos.
// La API key se lee de VITE_GEOAPIFY_KEY (Replit Secret). Si no hay
// key, funciona como un input de texto normal (no rompe nada).
function getGeoapifyKey(){
  try { return import.meta.env.VITE_GEOAPIFY_KEY || ""; } catch { return ""; }
}
function AddressAutocomplete({ value, onChange, onSelect, placeholder="Dirección", className }) {
  const [sugerencias,setSugerencias]=useState([]);
  const [abierto,setAbierto]=useState(false);
  const [cargando,setCargando]=useState(false);
  const timerRef = useRef(null);
  const cajaRef = useRef(null);
  const apiKey = getGeoapifyKey();

  // Buscar sugerencias con debounce de 350ms
  const buscar=(texto)=>{
    if(timerRef.current) clearTimeout(timerRef.current);
    if(!apiKey || !texto || texto.trim().length<3){ setSugerencias([]); setAbierto(false); return; }
    timerRef.current=setTimeout(async()=>{
      try{
        setCargando(true);
        const url=`https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(texto)}&filter=countrycode:us,co&format=json&limit=5&apiKey=${apiKey}`;
        const res=await fetch(url);
        const data=await res.json();
        const items=(data.results||[]).map(r=>({
          label: r.formatted || [r.address_line1,r.address_line2].filter(Boolean).join(", "),
          direccion: r.address_line1 || [r.housenumber,r.street].filter(Boolean).join(" ") || r.formatted || "",
          ciudad: r.city || r.county || r.state || "",
          cp: (r.postcode||"").toString().replace(/\D/g,"").slice(0,5),
        }));
        setSugerencias(items);
        setAbierto(items.length>0);
      }catch(e){
        setSugerencias([]); setAbierto(false);
      }finally{
        setCargando(false);
      }
    }, 350);
  };

  const elegir=(s)=>{
    setAbierto(false);
    setSugerencias([]);
    if(onSelect) onSelect({direccion:s.direccion||s.label, ciudad:s.ciudad, cp:s.cp});
  };

  return (
    <div className="relative" ref={cajaRef}>
      <input className={className||inpLight} value={value||""} placeholder={apiKey?placeholder:placeholder+" (escribe a mano)"}
        name="direccion-geoapify" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        onChange={e=>{ onChange(e.target.value); buscar(e.target.value); }}
        onFocus={()=>{ if(sugerencias.length>0) setAbierto(true); }} />
      {cargando && <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">…</div>}
      {abierto && sugerencias.length>0 && (
        <>
          <div className="fixed inset-0 z-40" onClick={()=>setAbierto(false)} />
          <div className="absolute z-50 left-0 right-0 mt-1 bg-white rounded-xl shadow-2xl border border-[#e8edf3] overflow-hidden max-h-64 overflow-y-auto">
            {sugerencias.map((s,i)=>(
              <button key={i} type="button" onClick={()=>elegir(s)}
                className="w-full flex items-start gap-2 px-3 py-2.5 text-left text-sm hover:bg-[#f4f6f9] transition border-b border-[#f4f6f9] last:border-0">
                <span className="text-base shrink-0"><Ico e="📍" /></span>
                <div className="min-w-0">
                  <div className="font-semibold text-slate-700 truncate">{s.direccion||s.label}</div>
                  <div className="text-[11px] text-slate-400 truncate">{[s.ciudad,s.cp].filter(Boolean).join(" · ")}</div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── CLIENT ROW ──────────────────────────���──────────────��─────
// ─── CALL MENU (dropdown de apps de llamada) ──────────────────
function CallMenu({ telefono, onCall, compact }) {
  const [open,setOpen]=useState(false);
  const [toast,setToast]=useState("");
  const doCopy = (label) => {
    copyNum(telefono);
    if(onCall) onCall();
    setOpen(false);
    setToast(`📋 ${intlNum(telefono)} copiado — abre ${label} y pega`);
    setTimeout(()=>setToast(""), 3000);
  };
  if(!telefono) return null;
  return (
    <div className="relative inline-block">
      <button onClick={()=>setOpen(p=>!p)}
        className={compact
          ? "w-9 h-9 rounded-full flex items-center justify-center text-white text-base shrink-0 hover:brightness-110 transition active:scale-95"
          : "inline-flex items-center gap-1.5 text-white font-bold px-2.5 py-1 rounded-md hover:brightness-110 transition text-xs"}
        style={{background:RP.blue}}>
        {compact ? "📞" : <><Ico e="📞" className="mr-1.5" />{telefono} <span className={`transition-transform ${open?"rotate-180":""}`}>▾</span></>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={()=>setOpen(false)} />
          <div className={`absolute z-50 mt-1 ${compact?"right-0":"left-0"} bg-white rounded-xl shadow-2xl border border-[#e8edf3] overflow-hidden`} style={{minWidth:"190px"}}>
            <div className="px-3 py-2 border-b border-[#f4f6f9]">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Llamar con…</div>
              <div className="text-[9px] text-slate-400 mt-0.5"><Ico e="📋" className="mr-1.5" />El número se copia automático</div>
            </div>
            {CALL_APPS.map(app=>(
              app.mode==="link" ? (
                <a key={app.id} href={app.href(telefono)} target={app.id==="gvoice"?"_blank":undefined} rel="noreferrer"
                  onClick={()=>{ copyNum(telefono); if(onCall) onCall(); setOpen(false); }}
                  className="flex items-center gap-3 px-3 py-2.5 text-sm font-bold hover:bg-[#f4f6f9] transition border-b border-[#f4f6f9] last:border-0">
                  <span className="w-6 flex items-center justify-center">{<Ico e={app.icon} size={16} />}</span>
                  <span style={{color:app.color}}>{app.label}</span>
                </a>
              ) : (
                <button key={app.id} type="button"
                  onClick={()=>doCopy(app.label)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-bold hover:bg-[#f4f6f9] transition border-b border-[#f4f6f9] last:border-0">
                  <span className="w-6 flex items-center justify-center">{<Ico e={app.icon} size={16} />}</span>
                  <span style={{color:app.color}}>{app.label}</span>
                  <span className="ml-auto text-[9px] text-slate-400 font-normal">copia el #</span>
                </button>
              )
            ))}
            <a href={waLink(telefono)} target="_blank" rel="noreferrer" onClick={()=>setOpen(false)}
              className="flex items-center gap-3 px-3 py-2.5 text-sm font-bold hover:bg-[#f4f6f9] transition bg-[#25D366]/5">
              <span className="w-6 text-center text-base"><Ico e="💬" /></span>
              <span style={{color:"#25D366"}}>WhatsApp</span>
            </a>
            <a href={smsLink(telefono)} onClick={()=>setOpen(false)}
              className="flex items-center gap-3 px-3 py-2.5 text-sm font-bold hover:bg-[#f4f6f9] transition border-t border-[#f4f6f9]">
              <span className="w-6 text-center text-base"><Ico e="✉" /></span>
              <span style={{color:"#7c3aed"}}>Mensaje de texto (SMS)</span>
            </a>
          </div>
        </>
      )}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] bg-[#1f2d3d] text-white text-xs font-bold px-4 py-2.5 rounded-full shadow-2xl whitespace-nowrap">
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── CLIENT ROW (compacta + expandible) ───────────────────────
function ClientRow({ c, onStatusChange, onEdit, onSchedule, onDelete, onRestore, onHardDelete, inPapelera, onCall, onApptResult, onSaveCallToHistorial, onSaveNota, type, role, onToggleRoute, isInRoute, agente, onDeleteHistorial, onMarcarLlamado, infoCobranza }) {
  const [expanded,setExpanded]=useState(false);
  const [showPicker,setShowPicker]=useState(false);
  const [showResult,setShowResult]=useState(false);
  const [showHistory,setShowHistory]=useState(false);
  const [showDetalles,setShowDetalles]=useState(false);
  const [showNotasHist,setShowNotasHist]=useState(false);
  const [nuevaNota,setNuevaNota]=useState("");
  const [notaMsg,setNotaMsg]=useState("");
  const [resultDetail,setResultDetail]=useState("");
  const [montoVenta,setMontoVenta]=useState(""); // monto de la venta (solo demo_venta)
  const [productoVenta,setProductoVenta]=useState(""); // producto vendido (solo demo_venta)
  const [filtroVenta,setFiltroVenta]=useState("");     // sub-producto de filtros de agua
  const [resultSelId,setResultSelId]=useState(""); // para saber si demo_venta está seleccionado
  const [callStatus,setCallStatus]=useState(null);
  const [estadoMsg,setEstadoMsg]=useState("");
  // E) Guard de seguridad: si no hay objeto o no tiene id válido, NO renderizar la tarjeta.
  // (va DESPUÉS de los hooks para respetar las reglas de React)
  const _idOk = c && (
    c._tipo==="referidos"
      ? (typeof c.id==="string" && (()=>{const p=c.id.split("::");return !!p[0]&&p[0]!=="undefined"&&p[0]!=="null"&&p[1]!==undefined&&p[1]!=="";})())
      : (c.id!==undefined && c.id!==null && c.id!=="")
  );
  if(!_idOk){
    return null;
  }
  const s=STATUS_COLORS[c.estado]||STATUS_COLORS.sin_estado;
  const isCita=c.estado==="verde";
  const historial=c.historial||[];
  // notas: solo entradas reales {texto,...}. Si el campo es texto legado, se
  // muestra como UNA nota (nunca se parte en letras) y se ignoran las vacías.
  const notas=(Array.isArray(c.notas)
    ? c.notas.filter(n=>n && typeof n==="object" && (n.texto||"").trim())
    : (typeof c.notas==="string" && c.notas.trim() ? [{texto:c.notas.trim()}] : []));
  const todayStr=hoyLocal();
  const seguimientoVencido = c.proximo_seguimiento && c.proximo_seguimiento <= todayStr;
  // Saldo/pago mensual sincronizados desde Cobranza (solo Distribución)
  const cbInfo = infoCobranza && (infoCobranza.saldo!==undefined || infoCobranza.pagoMensual!==undefined) ? infoCobranza : null;

  const guardarNota=()=>{
    const t=nuevaNota.trim();
    if(!t) return;
    if(onSaveNota) onSaveNota(c.id, t);
    setNuevaNota("");
    setNotaMsg("✅ Nota guardada");
    setTimeout(()=>setNotaMsg(""),2500);
  };

  const handleResultClick=(r)=>{
    if(r.id==="reset"){
      onApptResult(c,"reset",resultDetail);
      setShowResult(false); setResultDetail(""); setMontoVenta(""); setProductoVenta(""); setFiltroVenta(""); setResultSelId("");
      return;
    }
    if(isCita){
      const prodInfo = r.id==="demo_venta" ? resolveProducto(productoVenta, filtroVenta) : {label:"",meses:0};
      onApptResult(c,r.id,resultDetail, r.id==="demo_venta"?montoVenta:"", prodInfo.label, prodInfo.meses);
      if(onSaveCallToHistorial){
        const RES_LABEL={demo_venta:"💰 Demo / venta",demo_no_venta:"🎬 Demo / no venta",no_recibio:"🚪 No recibió",no_visito:"🚷 No se visitó",seguimiento:"📅 Llamar más adelante",recompra:"✖️ Recompra (no pagó)"};
        const montoNum = r.id==="demo_venta" ? Number(montoVenta)||0 : 0;
        onSaveCallToHistorial(c.id, makeHistorialEntry({
          tipo:"cita",
          estado:c.estado,
          cita_resultado:r.id,
          notas: resultDetail ? `${RES_LABEL[r.id]||r.id}${prodInfo.label?` — ${prodInfo.label}`:""} — ${resultDetail}${montoNum?` ($${montoNum})`:""}` : `${RES_LABEL[r.id]||r.id}${prodInfo.label?` — ${prodInfo.label}`:""}`,
          agente,
          monto: montoNum,
          producto: prodInfo.label,
          cartucho_meses: prodInfo.meses,
        }));
      }
    } else {
      onStatusChange(c.id,r.status);
      if(onSaveCallToHistorial) onSaveCallToHistorial(c.id, makeHistorialEntry({tipo:"llamada",estado:r.status,notas:resultDetail,agente}));
      if(r.id==="cita") onSchedule(c);
    }
    setShowResult(false); setResultDetail(""); setMontoVenta(""); setProductoVenta(""); setFiltroVenta(""); setResultSelId("");
  };

  return (
    <div className={`rounded-xl border border-[#e8edf3] border-l-4 shadow-sm relative ${s.cardBg||"bg-white"} ${s.border||"border-l-slate-300"}`}>

      {/* ══ FILA COMPACTA — nombre + color + llamar + expandir ══ */}
      <div className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer select-none active:bg-black/5 transition rounded-xl"
        onClick={()=>setExpanded(p=>!p)}>
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{background:s.hex}} />
        {(()=>{
          const SRC={
            agregado:{t:"AGG",bg:"#f1ecfd",c:"#5b21b6"}, agregados:{t:"AGG",bg:"#f1ecfd",c:"#5b21b6"},
            prospecto:{t:"PROS",bg:"#fef3e2",c:"#b45309"}, prospectos:{t:"PROS",bg:"#fef3e2",c:"#b45309"},
            distribucion:{t:"DIS",bg:"#e7f6ec",c:"#047857"},
            "referido-llamada":{t:"REF",bg:"#faf5ff",c:"#7c3aed"},
          };
          const sc=SRC[type];
          if(!sc) return null;
          return <span className="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded" style={{background:sc.bg,color:sc.c}} title={`Fuente: ${sc.t}`}>{sc.t}</span>;
        })()}
        <span className="font-bold text-sm text-[#1f2d3d] flex-1 truncate" style={{fontFamily:SERIF}}>
          {type==="referido" ? (c.anfitrion||"(Sin anfitrión)") : (c.nombre||"(Sin nombre)")}
          {type==="referido-llamada" && c._anfitrion && <span className="ml-1.5 text-[10px] font-normal text-purple-500"><Ico e="🎁" className="mr-1.5" />ref. de {c._anfitrion}</span>}
        </span>
        {cbInfo && (
          <span className="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200" title="Sincronizado desde Cobranza">
            💵 ${Number(cbInfo.saldo||0).toLocaleString("en-US",{minimumFractionDigits:0,maximumFractionDigits:0})}{cbInfo.pagoMensual?` · $${Number(cbInfo.pagoMensual).toLocaleString("en-US",{maximumFractionDigits:0})}/mes`:""}
          </span>
        )}
        {c.resultado==="venta" && <span className="text-sm shrink-0" title="Venta"><Ico e="💰" /></span>}
        {seguimientoVencido && !inPapelera && <span className="text-sm shrink-0" title="Seguimiento vencido"><Ico e="⏰" /></span>}
        {onToggleRoute && (()=>{
          // Solo califica para ruta si tiene dirección exacta (no solo ciudad)
          const dir=(c.direccion||"").trim();
          const ciudad=(c.ciudad||"").trim().toLowerCase();
          const tieneDirExacta = dir.length>0 && dir.toLowerCase()!==ciudad && /\d/.test(dir);
          if(tieneDirExacta){
            return (
              <button onClick={e=>{e.stopPropagation();onToggleRoute(c.id);}}
                className={`w-9 h-9 rounded-full flex items-center justify-center text-base shrink-0 transition active:scale-95 ${isInRoute?"text-white bg-emerald-600":"bg-[#f4f6f9] text-slate-500"}`}><Ico e="🗺" /></button>
            );
          }
          return (
            <span className="w-9 h-9 rounded-full flex items-center justify-center text-base shrink-0 bg-[#f4f6f9] opacity-40" title="Sin dirección exacta — no califica para ruta"><Ico e="🚫" /></span>
          );
        })()}
        <div onClick={e=>e.stopPropagation()}>
          <CallMenu telefono={c.telefono} onCall={onCall} compact />
        </div>
        <button onClick={e=>{e.stopPropagation();setExpanded(p=>!p);}} className={`text-slate-400 text-sm transition-transform duration-200 shrink-0 w-7 h-7 flex items-center justify-center rounded-full active:bg-black/5 ${expanded?"rotate-180":""}`} aria-label="Abrir/cerrar">▾</button>
      </div>

      {/* ══ PANEL EXPANDIDO ══ */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-[#f4f6f9]">

          {/* Estado — picker */}
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="relative">
              <button onClick={()=>setShowPicker(p=>!p)}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold transition active:brightness-90"
                style={s.style}>
                <span className="w-2 h-2 rounded-full shrink-0" style={{background:s.style?.color==="#1f2d3d"?"#1f2d3d":"rgba(255,255,255,0.85)"}} />
                {s.label}
                <span className={`transition-transform duration-150 ${showPicker?"rotate-180":""}`}>▾</span>
              </button>
              {showPicker && (
                <>
                  <div className="fixed inset-0 z-40" onClick={()=>setShowPicker(false)} />
                  <div className="absolute z-50 mt-1 left-0 bg-white rounded-xl shadow-2xl border border-[#e8edf3] overflow-hidden" style={{width:"220px",maxHeight:"60vh",overflowY:"auto"}}>
                    <div className="px-3 py-2 border-b border-[#f4f6f9] text-[10px] font-bold text-slate-400 uppercase tracking-wider">Cambiar estado</div>
                    <div className="p-1.5">
                      {Object.entries(STATUS_COLORS).map(([k,v])=>(
                        <button key={k} onClick={()=>{
                            if(k!==c.estado){
                              onStatusChange(c.id,k);
                              if(onSaveCallToHistorial) onSaveCallToHistorial(c.id, makeHistorialEntry({tipo:"estado",estado:k,notas:`Estado cambiado a ${v.label}`,agente}));
                            }
                            setShowPicker(false);
                            setEstadoMsg(`✅ Estado: ${v.label} — guardado`);
                            setTimeout(()=>setEstadoMsg(""),2500);
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-bold mb-1 last:mb-0 transition active:scale-95`}
                          style={{...v.style,outline:k===c.estado?"2px solid rgba(255,255,255,0.7)":"none"}}>
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{background:v.style.color==="#1f2d3d"?"#1f2d3d":"rgba(255,255,255,0.85)"}} />
                          <span className="flex-1 text-left">{v.label}</span>
                          {k===c.estado && <span className="text-xs font-black"><Ico e="✓" /></span>}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
            {c.asignado_a && <span className="inline-flex items-center gap-1 bg-[#5b21b6]/8 text-[#5b21b6] px-2 py-0.5 rounded-md font-bold text-[10px]"><Ico e="👤" className="mr-1.5" />{c.asignado_a}</span>}
          </div>
          {estadoMsg && <div className="mb-2 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5"><Msg>{estadoMsg}</Msg></div>}

          {/* Botón "Llamado" — manda este cliente al final de la lista de pendientes */}
          {onMarcarLlamado && (
            <button onClick={()=>{ onMarcarLlamado(c.id); setEstadoMsg("✅ Llamado registrado — pasa al final de la lista"); setTimeout(()=>setEstadoMsg(""),2500); }}
              className="w-full mb-2 flex items-center justify-center gap-2 text-xs font-bold py-2.5 px-3 rounded-lg text-white active:scale-95 transition" style={{background:"#16a34a"}}>
              <Ico e="✅" className="mr-1.5" />Marcar como llamado · pasar al final
              {c.ultimo_llamado && <span className="text-[10px] font-normal opacity-80">(últ: {new Date(c.ultimo_llamado).toLocaleDateString("es-MX",{day:"numeric",month:"short"})} {new Date(c.ultimo_llamado).toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"})})</span>}
            </button>
          )}

          {/* Badge de ORIGEN del dato */}
          {(()=>{
            const ORIGEN = {
              agregados:    {ico:"📂", label:"Agregados",     bg:"#f1ecfd", color:"#5b21b6"},
              prospectos:   {ico:"🔍", label:"Prospección",   bg:"#fef3e2", color:"#b45309"},
              prospecto:    {ico:"🔍", label:"Prospección",   bg:"#fef3e2", color:"#b45309"},
              distribucion: {ico:"🏠", label:"Distribución",  bg:"#e7f6ec", color:"#047857"},
              "referido-llamada": {ico:"🎁", label:"Referido", bg:"#faf5ff", color:"#7c3aed"},
            };
            const o = ORIGEN[type];
            if(!o) return null;
            return (
              <div className="mb-2 flex items-center gap-1.5 flex-wrap">
                <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md" style={{background:o.bg,color:o.color}}>
                  Origen: {o.label}
                </span>
                {type==="referido-llamada" && c._anfitrion && (
                  <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md bg-[#faf5ff] text-[#7c3aed]">
                    👤 Refirió: {c._anfitrion}{c._parentesco?` · ${c._parentesco}`:""}
                  </span>
                )}
                {type==="prospecto" && c.fuente && (
                  <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md bg-[#fef3e2] text-[#b45309]">
                    <Ico e="📲" className="mr-1.5" />{c.fuente}
                  </span>
                )}
              </div>
            );
          })()}

          {/* Info del cliente */}
          <div className="text-xs text-slate-500 space-y-1 mb-3">
            {c.telefono && <div><CallMenu telefono={c.telefono} onCall={onCall} /></div>}
            {type==="prospecto" && c.fuente && <div><span className="bg-[#e5def4] text-[#5b21b6] text-xs px-2 py-0.5 rounded-md font-bold">{c.fuente}</span></div>}
            {c.producto && <div><Ico e="📦" className="mr-1.5" />{c.producto}{c.cuenta?` — ${c.cuenta}`:""}</div>}
            {c.direccion && <div><Ico e="📍" className="mr-1.5" />{c.direccion}{c.ciudad?`, ${c.ciudad}`:""}{ c.cp?` ${c.cp}`:""}</div>}
            {type==="distribucion" && c.ultima_compra && <div><Ico e="🛒" className="mr-1.5" />Última compra: {c.ultima_compra}</div>}
            {c.proximo_seguimiento && <div className={seguimientoVencido?"text-red-500 font-bold":""}><Ico e="⏰" className="mr-1.5" />Seguimiento: {c.proximo_seguimiento}{seguimientoVencido?" (vencido)":""}</div>}
            {c.observaciones && <div className="text-slate-400 italic">"{c.observaciones}"</div>}
            {c.resultado && RESULTADO_STYLE[c.resultado] && (
              <div><span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-md" style={RESULTADO_STYLE[c.resultado].style}>{RESULTADO_STYLE[c.resultado].label}</span></div>
            )}
            {c.resultado_detalle && <div className="text-[#5b21b6] text-xs bg-[#5b21b6]/6 rounded-lg px-2 py-1"><Ico e="📝" className="mr-1.5" />{c.resultado_detalle}</div>}
          </div>

          {/* ── ÚLTIMA NOTA + AGREGAR NOTA ── */}
          {!inPapelera && (
            <div className="mb-3 rounded-xl border border-[#e8edf3] overflow-hidden">
              {c.ultimaNota && (
                <div className="px-3 py-2 bg-amber-50 border-b border-amber-100">
                  <div className="text-[9px] font-black text-amber-600 uppercase tracking-wider mb-0.5"><Ico e="📌" className="mr-1.5" />Última nota</div>
                  <div className="text-xs text-slate-700">{c.ultimaNota}</div>
                </div>
              )}
              <div className="p-2 bg-white">
                <div className="flex gap-1.5">
                  <input value={nuevaNota} onChange={e=>setNuevaNota(e.target.value)}
                    onKeyDown={e=>{if(e.key==="Enter")guardarNota();}}
                    placeholder="Escribir nueva nota…"
                    className="flex-1 border border-[#e5def4] rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#7c3aed]" />
                  <button onClick={guardarNota} disabled={!nuevaNota.trim()}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-40" style={{background:"#16a34a"}}>Guardar</button>
                </div>
                {notaMsg && <div className="text-[10px] font-bold text-emerald-600 mt-1"><Msg>{notaMsg}</Msg></div>}
                {notas.length>0 && (
                  <button onClick={()=>setShowNotasHist(p=>!p)} className="text-[10px] font-bold text-[#7c3aed] mt-1.5">
                    {showNotasHist?"Ocultar":"Ver"} historial de notas ({notas.length})
                  </button>
                )}
                {showNotasHist && notas.length>0 && (
                  <div className="mt-1.5 space-y-1 max-h-40 overflow-y-auto">
                    {[...notas].reverse().map((n,i)=>{
                      const d=new Date(n.fecha);
                      const fechaOk=n.fecha && !isNaN(d.getTime());
                      return (
                        <div key={i} className="bg-[#f4f6f9] rounded-lg px-2 py-1.5 text-[11px]">
                          <div className="text-slate-700">{n.texto}</div>
                          <div className="text-[9px] text-slate-400 mt-0.5">
                            {fechaOk ? <><Ico e="📅" className="mr-1.5" />{d.toLocaleDateString("es-MX",{day:"numeric",month:"short"})} <Ico e="🕐" /> {d.toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"})}</> : <><Ico e="📅" className="mr-1" />—</>}{n.agente?<> · <Ico e="👤" /> {n.agente}</>:null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── BOTÓN DETALLES ── */}
          <button onClick={()=>setShowDetalles(p=>!p)}
            className="w-full mb-3 flex items-center justify-between px-3 py-2 rounded-xl border border-[#e5def4] bg-[#f4f6f9] hover:bg-[#f1ecfd] transition text-xs font-bold text-[#5b21b6]">
            <span><Ico e="📋" className="mr-1.5" />{showDetalles?"Ocultar detalles":"Ver detalles completos"}</span>
            <span className={`transition-transform duration-200 ${showDetalles?"rotate-180":""}`}>▾</span>
          </button>
          {showDetalles && (
            <div className="mb-3 rounded-xl border border-[#e5def4] overflow-hidden">
              <div className="px-3 py-2 text-xs font-black text-white uppercase tracking-wide" style={{background:RP.navy}}><Ico e="📋" className="mr-1.5" />Detalles del cliente</div>
              <div className="divide-y divide-[#f4f6f9] text-xs">
                {[
                  ["Nombre", c.nombre],
                  ["N° de cuenta", c.cuenta],
                  ["Dirección", c.direccion],
                  ["Ciudad", c.ciudad],
                  ["📱 Móvil", c.telefonoMovil||c.telefono],
                  ["🏠 Casa", c.telefonoCasa],
                  ["💼 Trabajo", c.telefonoTrabajo],
                  ["Vendedor", c.vendedor],
                  ["Nivel del cliente", c.nivelCliente],
                  ["Límite de crédito", c.limiteCredito],
                  ["Saldo actual", c.saldoActual],
                  ["Productos", Array.isArray(c.productos)&&c.productos.length?c.productos.join(", "):(c.producto||"")],
                  ["Otros detalles", c.otrosDetalles],
                  ["Observaciones", c.observaciones],
                ].filter(([,v])=>v && String(v).trim()).map(([label,val],i)=>(
                  <div key={i} className="flex px-3 py-1.5">
                    <span className="text-slate-400 font-bold w-32 shrink-0">{label}</span>
                    <span className="text-slate-700 flex-1 break-words">{val}</span>
                  </div>
                ))}
                <div className="flex px-3 py-1.5 bg-[#f9fafb]">
                  <span className="text-slate-400 font-bold w-32 shrink-0">Fecha agregado</span>
                  <span className="text-slate-500 flex-1">{c.creado?new Date(c.creado).toLocaleDateString("es-MX",{day:"numeric",month:"short",year:"numeric"}):"—"}</span>
                </div>
                {c.actualizado && (
                  <div className="flex px-3 py-1.5 bg-[#f9fafb]">
                    <span className="text-slate-400 font-bold w-32 shrink-0">Última actualización</span>
                    <span className="text-slate-500 flex-1">{new Date(c.actualizado).toLocaleDateString("es-MX",{day:"numeric",month:"short",year:"numeric"})} {new Date(c.actualizado).toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"})}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Botones de acción */}
          <div className="flex gap-1.5 flex-wrap">
            {!inPapelera && (
              <button onClick={()=>setShowResult(p=>!p)}
                className={`flex-1 text-xs font-bold py-2 px-2 rounded-lg transition ${showResult?"text-white":"text-[#5b21b6]"}`}
                style={showResult?{background:RP.navy}:{background:"#f1ecfd"}}>
                {isCita?<><Ico e="🎯" className="mr-1" />Resultado cita</>:<><Ico e="📞" className="mr-1" />Resultado</>}
              </button>
            )}
            {!inPapelera && <button onClick={()=>onSchedule(c)} className="flex-1 text-xs font-bold py-2 px-2 rounded-lg bg-[#7c3aed]/12 text-[#7c3aed]"><Ico e="📅" className="mr-1.5" />Agendar</button>}
            {!inPapelera && <button onClick={()=>onEdit(c)} className="text-xs font-bold py-2 px-2 rounded-lg bg-[#f4f6f9] text-slate-600"><Ico e="✏" /></button>}
            {!inPapelera && <button onClick={()=>onDelete(c.id)} className="text-xs font-bold py-2 px-2 rounded-lg bg-red-50 text-red-500" title="Mover a papelera"><Ico e="🗑" /></button>}
            {inPapelera && <button onClick={()=>onRestore(c.id)} className="flex-1 text-xs font-bold py-2 px-2 rounded-lg bg-emerald-50 text-emerald-600"><Ico e="♻" className="mr-1.5" />Restaurar</button>}
            {inPapelera && <button onClick={()=>{if(confirm("¿Eliminar permanentemente? No se puede deshacer."))onHardDelete(c.id);}} className="flex-1 text-xs font-bold py-2 px-2 rounded-lg bg-red-100 text-red-600"><Ico e="🗑" className="mr-1.5" />Definitivo</button>}
          </div>

          {/* Panel de resultado */}
          {showResult && !inPapelera && (
            <div className="mt-3 rounded-xl overflow-hidden border border-[#5b21b6]/15">
              <div className="px-3 py-2 text-xs font-bold text-white tracking-wide uppercase" style={{background:RP.navy}}>
                {isCita?<><Ico e="🎯" className="mr-1" />Resultado de la cita</>:<><Ico e="☎" className="mr-1" />Registrar llamada</>}
              </div>
              <div className="p-2 bg-[#f1ecfd]">
                {isCita ? (
                  <>
                    {/* Agendar OTRA cita a un cliente que ya está en verde */}
                    <button onClick={()=>{ onSchedule(c); setShowResult(false); }}
                      className="w-full mb-2 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-bold text-white active:scale-95 transition"
                      style={{background:RP.navy}}>
                      <Ico e="📅" className="mr-1.5" />Agendar otra cita
                    </button>
                    {/* CITA: nota + botones de resultado directos */}
                    <div className="mb-2">
                      <textarea className="w-full border-2 border-[#e5def4] bg-white rounded-lg px-3 py-2 text-sm text-[#1f2d3d] focus:outline-none focus:border-[#5b21b6] resize-none placeholder:text-slate-400"
                        rows={2} maxLength={300} placeholder="Detalle del resultado (opcional)…"
                        value={resultDetail} onChange={e=>setResultDetail(e.target.value)} />
                      <div className="text-right text-[10px] text-slate-400 font-bold mt-0.5">{resultDetail.length}/300</div>
                    </div>

                    {/* Paso 2: campo de monto (solo si ya tocó demo_venta) */}
                    {resultSelId==="demo_venta" && (
                      <div className="mb-3 p-2.5 rounded-xl border-2 border-emerald-300 bg-emerald-50">
                        <div className="text-[11px] font-black text-emerald-700 uppercase tracking-wider mb-2"><Ico e="💵" className="mr-1.5" />¿Cuánto fue la venta?</div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-base font-bold text-slate-500">$</span>
                          <input type="number" value={montoVenta} onChange={e=>setMontoVenta(e.target.value)}
                            className="flex-1 border-2 border-emerald-400 bg-white rounded-lg px-3 py-2 text-base font-bold text-emerald-800 focus:outline-none focus:border-emerald-600 placeholder:text-slate-300"
                            placeholder="0.00" min="0" step="0.01" autoFocus />
                        </div>
                        {/* Producto vendido */}
                        <div className="text-[11px] font-black text-emerald-700 uppercase tracking-wider mb-1.5"><Ico e="📦" className="mr-1.5" />¿Qué producto vendió?</div>
                        <select value={productoVenta} onChange={e=>{setProductoVenta(e.target.value); setFiltroVenta("");}}
                          className="w-full border-2 border-emerald-400 bg-white rounded-lg px-3 py-2 text-sm font-bold text-emerald-800 focus:outline-none focus:border-emerald-600 mb-2">
                          <option value="">— Selecciona el producto —</option>
                          {PRODUCTOS_VENTA.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
                        </select>
                        {productoVenta==="filtros" && (
                          <select value={filtroVenta} onChange={e=>setFiltroVenta(e.target.value)}
                            className="w-full border-2 border-emerald-400 bg-white rounded-lg px-3 py-2 text-sm font-bold text-emerald-800 focus:outline-none focus:border-emerald-600 mb-2">
                            <option value="">— Tipo de filtro —</option>
                            {PRODUCTOS_VENTA.find(p=>p.id==="filtros").sub.map(s=><option key={s.id} value={s.id}>{s.label} (cada {s.meses} meses)</option>)}
                          </select>
                        )}
                        {productoVenta==="filtros" && filtroVenta && (
                          <div className="text-[10px] text-emerald-600 mb-2"><Ico e="🔔" className="mr-1.5" />Te avisaré cuando toque el cambio de cartucho.</div>
                        )}
                        {productoVenta==="purificador" && (
                          <div className="text-[10px] text-emerald-600 mb-2"><Ico e="🔔" className="mr-1.5" />Te avisaré cada año para su mantenimiento.</div>
                        )}
                        <div className="grid grid-cols-2 gap-2">
                          <button onClick={()=>{setResultSelId("");setMontoVenta("");setProductoVenta("");setFiltroVenta("");}}
                            className="px-3 py-2 rounded-lg text-xs font-bold bg-white border border-slate-200 text-slate-500">Cancelar</button>
                          <button onClick={()=>handleResultClick(APPT_RESULTS.find(r=>r.id==="demo_venta"))}
                            className="px-3 py-2 rounded-lg text-xs font-bold text-white" style={{background:"#047857"}}>
                            💰 Confirmar venta {montoVenta?`$${montoVenta}`:""}
                          </button>
                        </div>
                        <div className="text-[10px] text-emerald-600 mt-1.5">El valor se suma al total vendido del incentivo.</div>
                      </div>
                    )}

                    {/* Botones de resultado — demo_venta pre-selecciona, los demás guardan directo */}
                    {resultSelId!=="demo_venta" && (
                      <div className="grid grid-cols-2 gap-2">
                        {APPT_RESULTS.map(r=>(
                          <button key={r.id}
                            onClick={()=>{ if(r.id==="demo_venta"){ setResultSelId("demo_venta"); } else { handleResultClick(r); } }}
                            style={{background:r.bg,color:r.text}}
                            className="flex items-center justify-center gap-1.5 text-center px-3 py-3 rounded-lg text-sm font-bold shadow-sm hover:brightness-105 active:scale-95 transition">
                            <Ico e={r.ico} size={15} />{r.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {/* LLAMADA: elegir estado + nota + botón Guardar */}
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">1. ¿Qué pasó en la llamada?</div>
                    <div className="grid grid-cols-2 gap-2 mb-3">
                      {CALL_RESULTS.map(r=>(
                        <button key={r.id} onClick={()=>setCallStatus(r)}
                          style={callStatus?.id===r.id?{background:r.bg,color:r.text}:{background:"#fff",color:"#64748b"}}
                          className={`flex items-center justify-center gap-1.5 text-center px-3 py-2.5 rounded-lg text-sm font-bold shadow-sm hover:brightness-105 active:scale-95 transition ${callStatus?.id===r.id?"ring-2 ring-offset-1 ring-[#5b21b6]":"border border-[#e5def4]"}`}>
                          <Ico e={r.ico} size={15} />{r.label}
                        </button>
                      ))}
                    </div>
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">2. Nota de la llamada (opcional)</div>
                    <textarea className="w-full border-2 border-[#e5def4] bg-white rounded-lg px-3 py-2 text-sm text-[#1f2d3d] focus:outline-none focus:border-[#5b21b6] resize-none placeholder:text-slate-400 mb-2"
                      rows={2} maxLength={300} placeholder="Ej: No contestó, llamar mañana. / Interesado, agendar cita…"
                      value={resultDetail} onChange={e=>setResultDetail(e.target.value)} />
                    <button onClick={()=>{
                        if(!callStatus){ return; }
                        onStatusChange(c.id, callStatus.status);
                        if(onSaveCallToHistorial) onSaveCallToHistorial(c.id, makeHistorialEntry({tipo:"llamada",estado:callStatus.status,notas:resultDetail,agente}));
                        if(callStatus.id==="cita") onSchedule(c);
                        setShowResult(false); setResultDetail(""); setCallStatus(null); setShowHistory(true);
                      }}
                      disabled={!callStatus}
                      className="w-full px-4 py-3 rounded-xl text-sm font-bold text-white transition disabled:opacity-40"
                      style={{background: callStatus ? "#16a34a" : "#94a3b8"}}>
                      💾 {callStatus ? `Guardar llamada — ${callStatus.label}` : "Selecciona qué pasó arriba"}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Historial */}
          <button onClick={()=>setShowHistory(p=>!p)}
            className="w-full mt-3 flex items-center justify-between px-3 py-2 rounded-xl border border-[#e5def4] bg-[#f4f6f9] hover:bg-[#f1ecfd] transition text-xs font-bold text-[#5b21b6]">
            <span><Ico e="📊" className="mr-1.5" />{showHistory?"Ocultar historial":"Ver historial"} {historial.length>0?`(${historial.length} contacto${historial.length!==1?"s":""})`:"— sin registros"}</span>
            <span className={`transition-transform duration-200 ${showHistory?"rotate-180":""}`}>▾</span>
          </button>

          {showHistory && (
            <div className="mt-2 rounded-xl overflow-hidden border border-[#e5def4]">
              <div className="px-3 py-2 text-xs font-black text-white uppercase tracking-wide" style={{background:RP.navy}}>
                <Ico e="📊" className="mr-1.5" />Historial de contactos
              </div>
              {historial.length===0 ? (
                <div className="p-4 text-center text-xs text-slate-400">Sin registros todavía</div>
              ) : (
                <div className="divide-y divide-[#e8edf3]">
                  {[...historial].reverse().map((h,i)=>{
                    const esCita=h.tipo==="cita";
                    const esEstado=h.tipo==="estado";
                    const d=new Date(h.fecha);
                    const fechaStr=d.toLocaleDateString("es-MX",{day:"numeric",month:"short",year:"numeric"});
                    const horaStr=d.toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"});
                    const estInfo=STATUS_COLORS[h.estado];
                    const resInfo=RESULTADO_STYLE[h.cita_resultado];
                    const icono = esCita?"📋":esEstado?"🏷️":"📞";
                    const titulo = esCita?"Cita":esEstado?"Cambio de estado":"Llamada";
                    return (
                      <div key={h.id||i} className={`p-3 ${esCita?"bg-[#f0f7ff]":esEstado?"bg-[#faf8ff]":"bg-white"}`}>
                        <div className="flex items-start gap-2.5">
                          <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-base mt-0.5"
                            style={{background:esCita?RP.navy:esEstado?"#7c3aed":"#e8edf3"}}>
                            {icono}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-1.5">
                              <span className="text-xs font-black text-[#1f2d3d]">{titulo}</span>
                              <span className="text-[10px] text-slate-400 bg-white border border-[#e8edf3] px-1.5 py-0.5 rounded-md"><Ico e="📅" className="mr-1.5" />{fechaStr}</span>
                              <span className="text-[10px] text-slate-400 bg-white border border-[#e8edf3] px-1.5 py-0.5 rounded-md"><Ico e="🕐" className="mr-1.5" />{horaStr}</span>
                              {h.agente && <span className="text-[10px] text-[#5b21b6] bg-[#5b21b6]/8 px-1.5 py-0.5 rounded-md font-bold"><Ico e="👤" className="mr-1.5" />{h.agente}</span>}
                            </div>
                            {(!esCita) && estInfo && (
                              <div className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md mb-1" style={estInfo.style}>{estInfo.label}</div>
                            )}
                            {esCita && resInfo && (
                              <div className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md mb-1" style={resInfo.style}>{resInfo.label}</div>
                            )}
                            {esCita && !resInfo && (
                              <div className="text-[10px] text-slate-400 italic mb-1">Sin resultado registrado</div>
                            )}
                            {h.notas && (
                              <div className="text-[10px] text-slate-500 italic bg-white rounded-lg px-2 py-1 border border-[#e8edf3] mt-1">📝 "{h.notas}"</div>
                            )}
                          </div>
                          {/* Eliminar este registro del historial (con confirmación) */}
                          {onDeleteHistorial && (h.id||h.fecha) && (
                            <button onClick={()=>{
                              if(confirm(`¿Eliminar este registro de ${titulo.toLowerCase()} del ${fechaStr}?\n\nEsto solo borra este registro del historial. El cliente y sus demás datos NO se tocan.`)){
                                onDeleteHistorial(c.id, h.id||h.fecha);
                              }
                            }} className="text-red-300 hover:text-red-500 text-xs shrink-0 px-1" title="Eliminar este registro"><Ico e="🗑" /></button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── DB SECTION ───────────────────────────────────────────────
function DBSection({ data, setData, type, title, onCallLog, role, allData, agente, notify, setAppts, rolActivo="", cobranzaClientes=null }) {
  // Exportar (CSV/PDF) solo para roles de gestión — NUNCA telemarketing/vendedor
  const puedeExportar = puedeExportarRol(rolActivo);
  const [search,setSearch]=useState("");const [filterStatus,setFilterStatus]=useState("todos");
  const [filterCity,setFilterCity]=useState("");const [filterCP,setFilterCP]=useState("");
  const [showRoute,setShowRoute]=useState(false);const [routeSel,setRouteSel]=useState([]);
  const [showPapelera,setShowPapelera]=useState(false);
  const [showForm,setShowForm]=useState(false);const [editItem,setEditItem]=useState(null);
  const [scheduleClient,setScheduleClient]=useState(null);const [forceTipo,setForceTipo]=useState(null);
  const [calLoading,setCalLoading]=useState(false);const [calMsg,setCalMsg]=useState("");
  const [dupMsg,setDupMsg]=useState("");
  const norm=(t)=>(t||"").toString().trim().toLowerCase();
  const cities=[...new Set(data.map(c=>(c.ciudad||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"es"));
  // Estado del filtro de código postal (exacto con 5 dígitos)
  const zipQuery = normalizeZip(filterCP);
  const zipIncompleto = zipQuery.length>0 && zipQuery.length<5;
  const eliminados = data.filter(c=>c.eliminado);
  // Descartar registros sin id válido (igual criterio que CallControl)
  const _tieneIdValidoDB=(c)=>{
    if(!c) return false;
    if(c._tipo==="referidos"){
      if(typeof c.id!=="string") return false;
      const p=c.id.split("::");
      return !!p[0] && p[0]!=="undefined" && p[0]!=="null" && p[1]!==undefined && p[1]!=="";
    }
    return c?.id!==undefined && c?.id!==null && c?.id!=="";
  };
  const _baseDB = data.filter(c=> showPapelera ? c.eliminado : !c.eliminado);
  const filtered=data.filter(c=>{
    if(showPapelera) return c.eliminado;          // en papelera solo mostramos eliminados
    if(c.eliminado) return false;                 // ocultar eliminados de la vista normal
    if(!_tieneIdValidoDB(c)) return false;        // C) descartar registros sin id válido
    // Búsqueda global unificada (nombre/teléfono/ciudad/estado/CP/dirección, sin acentos)
    return coincideBusqueda(c, {search, filterStatus, filterCity, filterCP});
  });
  const toggleRoute=id=>setRouteSel(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);
  const routeList=filtered.filter(c=>routeSel.includes(c.id));
  const saveNew=d=>{
    if(editItem){ setData(p=>p.map(x=>x.id===editItem.id?{...d,id:editItem.id}:x)); setShowForm(false);setEditItem(null); return; }
    if(type!=="referido" && allData && isDuplicate(d, allData)){
      setDupMsg(`⚠️ "${d.nombre||"Sin nombre"}" con ese teléfono ya existe. No se agregó duplicado.`);
      setShowForm(false); return;
    }
    setData(p=>[{...d,id:genId(),creado:d.creado||new Date().toISOString()},...p]);
    if(notify) notify("datos",
      `📂 Dato nuevo agregado por ${agente}`,
      `${d.nombre||"Sin nombre"}${d.telefono?` · ${d.telefono}`:""} en ${title}`,
      title
    );
    setShowForm(false);setEditItem(null);
  };
  const openSchedule=(client,tipo=null)=>{setScheduleClient(client);setForceTipo(tipo);};
  const handleSchedule=appt=>{
    setCalMsg("");
    window.open(gcalLink(appt),"_blank");
    if(setAppts) setAppts(p=>[{...appt,id:genId(),_type:appt.tipo},...p]);

    // ── OBJETIVO 3: Actualizar tarjeta del cliente con datos del appt ──
    if(scheduleClient){
      setData(p=>p.map(x=>{
        if(x.id!==scheduleClient.id) return x;
        const upd={...x};
        // Teléfono: solo rellenar si está vacío
        if(!upd.telefono && appt.telefono) upd.telefono=appt.telefono;
        // Dirección: solo rellenar si está vacía (no sobrescribir si difiere)
        if(!upd.direccion && appt.direccion) upd.direccion=appt.direccion;
        // Ciudad: solo rellenar si está vacía
        if(!upd.ciudad && appt.ciudad) upd.ciudad=appt.ciudad;
        // CP: solo rellenar si está vacío
        if(!upd.cp && appt.cp) upd.cp=appt.cp;
        // Cuenta: solo rellenar si está vacía
        if(!upd.cuenta && appt.cuenta) upd.cuenta=appt.cuenta;
        // Nota de la cita → al historial + última nota visible
        if(appt.notas && appt.notas.trim()){
          const notaCita=`[Cita ${appt.tipo||"cita"} ${(appt.fecha||"").slice(0,10)}] ${appt.notas.trim()}`;
          upd.ultimaNota=notaCita;
          upd.notas=[...(upd.notas||[]),{texto:notaCita,fecha:new Date().toISOString(),agente:appt.agente||agente}];
        }
        // Próximo seguimiento: si el tipo es seguimiento o llamada
        if(["llamada","seguimiento","reset"].includes(appt.tipo) && appt.fecha){
          upd.proximo_seguimiento=(appt.fecha||"").slice(0,10);
        }
        // Marcar última cita programada
        upd.ultima_cita_programada=(appt.fecha||"").slice(0,16);
        upd.actualizado=new Date().toISOString();
        return upd;
      }));
    }

    setCalMsg(`✅ ${EVENT_CONFIG[appt.tipo]?.emoji||"📋"} ${appt.nombre} — cita guardada en Agenda y se abrió Google Calendar: solo toca GUARDAR allá.`);
    setScheduleClient(null);setForceTipo(null);
  };
  const handleApptResult=(c,id,detail="",monto="",producto="",cartucho_meses=0)=>{
    const RLABEL={demo_venta:"💰 Demo / venta",demo_no_venta:"🎬 Demo / no venta",no_recibio:"🚪 No recibió",no_visito:"🚷 No se visitó",seguimiento:"📅 Llamar más adelante",recompra:"✖️ Recompra (no pagó su deuda)"};
    const montoNum = id==="demo_venta" ? Number(monto)||0 : 0;
    if(id==="demo_venta")      setData(p=>p.map(x=>x.id===c.id?{...x,venta:true, resultado:"demo_venta",    resultado_detalle:detail||x.resultado_detalle, ultimo_monto_venta:montoNum||x.ultimo_monto_venta, ultimo_producto:producto||x.ultimo_producto, ultimo_cartucho_meses:cartucho_meses||x.ultimo_cartucho_meses}:x));
    else if(id==="demo_no_venta")  setData(p=>p.map(x=>x.id===c.id?{...x,venta:false,resultado:"demo_no_venta", resultado_detalle:detail||x.resultado_detalle}:x));
    else if(id==="no_recibio") setData(p=>p.map(x=>x.id===c.id?{...x,venta:false,resultado:"no_recibio",resultado_detalle:detail||x.resultado_detalle}:x));
    else if(id==="no_visito") setData(p=>p.map(x=>x.id===c.id?{...x,venta:false,resultado:"no_visito",resultado_detalle:detail||x.resultado_detalle}:x));
    else if(id==="seguimiento"){setData(p=>p.map(x=>x.id===c.id?{...x,resultado:"seguimiento",resultado_detalle:detail||x.resultado_detalle}:x)); openSchedule(c,"llamada");}
    else if(id==="reset"){setData(p=>p.map(x=>x.id===c.id?{...x,resultado:"reset",resultado_detalle:detail||x.resultado_detalle}:x)); openSchedule(c,"reset");}
    else if(id==="recompra") setData(p=>p.map(x=>x.id===c.id?{...x,venta:false,resultado:"recompra",resultado_detalle:detail||"No pagó su deuda anterior — no sacar cita",recompra:true}:x));
    if(notify) notify("resultado",
      `🎯 Resultado de cita registrado por ${agente}`,
      `${c.nombre||"Cliente"} → ${RLABEL[id]||id}${producto?` · ${producto}`:""}${detail?` · "${detail}"`:""}${montoNum?` · $${montoNum}`:""}`,
      title
    );
  };
  const exportCSV=()=>{const cols=type==="referido"?["anfitrion","regalo","estado"]:type==="distribucion"?["nombre","cuenta","telefono","producto","ciudad","cp","direccion","ultima_compra","observaciones","estado"]:type==="prospecto"?["nombre","telefono","fuente","producto","ciudad","cp","direccion","observaciones","estado"]:["nombre","cuenta","telefono","producto","ciudad","cp","direccion","observaciones","estado"];const rows=[cols.join(","),...filtered.map(r=>cols.map(c=>`"${(r[c]||"").toString().replace(/"/g,'""')}"`).join(","))];const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([rows.join("\n")],{type:"text/csv"}));a.download=`${type}_${Date.now()}.csv`;a.click();};
  return (
    <div>
      {calMsg && <div className="mb-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-700 font-bold flex items-center justify-between"><Msg>{calMsg}</Msg><button onClick={()=>setCalMsg("")} className="ml-2"><Ico e="✕" /></button></div>}
      {dupMsg && <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-300 text-sm text-amber-800 font-bold flex items-center justify-between"><Msg>{dupMsg}</Msg><button onClick={()=>setDupMsg("")} className="ml-2"><Ico e="✕" /></button></div>}

      {/* Search + status */}
      <div className="flex items-center gap-2 mb-2">
        <input className={inpLight+" flex-1"} placeholder="Buscar por nombre o teléfono…" name={`buscar-${type}`} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} value={search} onChange={e=>setSearch(e.target.value)} />
        <select className="border-2 border-[#e5def4] rounded-lg px-2 py-2 text-xs bg-white shrink-0 font-bold" value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}><option value="todos">Todos</option>{Object.entries(STATUS_COLORS).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select>
      </div>

      {/* City + CP filter */}
      <div className="flex gap-2 mb-3">
        <div className="flex-1 relative">
          <input list={`ciudades-${type}`} className="w-full border-2 border-[#e5def4] rounded-lg px-2 py-2 text-xs bg-white font-bold text-slate-700 focus:outline-none focus:border-[#7c3aed]"
            placeholder={`Filtrar ciudad (${cities.length} disponibles)`}
            name={`filtro-ciudad-${type}`} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            value={filterCity} onChange={e=>setFilterCity(e.target.value)} />
          <datalist id={`ciudades-${type}`}>
            {cities.map(c=><option key={c} value={c}>{c}</option>)}
          </datalist>
        </div>
        <input className="border-2 border-[#e5def4] rounded-lg px-2 py-2 text-xs bg-white font-bold text-slate-700 w-24"
          placeholder="C.P. (5 díg)" inputMode="numeric" maxLength={10}
          name={`filtro-cp-${type}`} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          value={filterCP} onChange={e=>setFilterCP(e.target.value)} />
        {(filterCity||filterCP) && <button onClick={()=>{setFilterCity("");setFilterCP("");}} className="text-xs text-red-400 font-bold px-1 hover:text-red-600"><Ico e="✕" /></button>}
      </div>
      {zipIncompleto && <div className="mb-3 text-xs font-bold text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"><Ico e="📮" className="mr-1.5" />Escribe 5 dígitos para filtrar por código postal</div>}

      {/* Action buttons */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {!showPapelera && <PrimaryBtn onClick={()=>{setEditItem(null);setShowForm(true);}}>+ Agregar</PrimaryBtn>}
        {puedeExportar && <button onClick={exportCSV} className="px-3 py-2.5 rounded-lg text-xs font-bold bg-[#f4f6f9] text-slate-700 border border-[#e5def4]"><Ico e="📥" className="mr-1.5" />CSV</button>}
        {puedeExportar && <button onClick={()=>exportToPDF(filtered,title)} className="px-3 py-2.5 rounded-lg text-xs font-bold text-white" style={{background:RP.navyDark}}><Ico e="🖨" className="mr-1.5" />PDF</button>}
        {type!=="referido" && !showPapelera && <button onClick={()=>{setShowRoute(p=>!p);setRouteSel([]);}}
          className={`px-3 py-2.5 rounded-lg text-xs font-bold border transition ${showRoute?"text-white border-transparent":"border-[#e5def4] text-[#5b21b6] bg-[#f4f6f9]"}`}
          style={showRoute?{background:RP.navy}:{}}><Ico e="🗺" className="mr-1.5" />Ruta</button>}
        <button onClick={()=>{setShowPapelera(p=>!p);setShowRoute(false);}}
          className={`px-3 py-2.5 rounded-lg text-xs font-bold border transition ${showPapelera?"text-white border-transparent":"border-[#e5def4] text-slate-500 bg-[#f4f6f9]"}`}
          style={showPapelera?{background:"#dc2626"}:{}}><Ico e="🗑" className="mr-1.5" />Papelera{eliminados.length>0?` (${eliminados.length})`:""}</button>
        <span className="ml-auto text-xs text-slate-400 self-center font-bold">{filtered.length} registro(s)</span>
      </div>

      {showPapelera && (
        <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 font-bold">
          🗑️ Papelera — los registros eliminados se pueden restaurar aquí. "Eliminar definitivo" no se puede deshacer.
        </div>
      )}

      {/* Route planner panel */}
      {showRoute && (
        <div className="mb-4 bg-[#f4f6f9] rounded-xl p-3 border border-[#e5def4]">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-bold text-[#5b21b6] uppercase tracking-wider"><Ico e="🗺" className="mr-1.5" />Planeador de ruta</div>
            <span className="text-xs font-bold text-slate-500">{routeSel.length} parada(s)</span>
          </div>
          <div className="text-[10px] text-slate-400 mb-2">Solo aparece 🗺️ en clientes con dirección exacta. Las paradas van en el orden que las seleccionas.</div>
          {routeList.length>0 && (
            <div className="space-y-1 mb-3 max-h-36 overflow-y-auto">
              {routeList.map((c,i)=>(
                <div key={c.id} className="flex items-center gap-2 text-xs bg-white rounded-lg px-3 py-2 border border-[#e8edf3]">
                  <span className="font-black text-[#5b21b6] w-5 text-center shrink-0">{i+1}</span>
                  <span className="font-bold text-[#1f2d3d] truncate flex-1">{c.nombre}</span>
                  <span className="text-slate-400 text-[10px] truncate"><Ico e="📍" className="mr-1.5" />{c.direccion||"—"}</span>
                  <button onClick={()=>toggleRoute(c.id)} className="ml-1 text-red-400 font-bold shrink-0"><Ico e="✕" /></button>
                </div>
              ))}
            </div>
          )}
          {routeList.length>0
            ? <a href={`https://www.google.com/maps/dir/${routeList.map(c=>encodeURIComponent((c.direccion||"").trim())).filter(Boolean).join("/")}`}
                target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold text-white hover:brightness-110 transition" style={{background:"#16a34a"}}>
                <Ico e="🗺" className="mr-1.5" />Abrir ruta en Google Maps ({routeList.length} paradas)
              </a>
            : <div className="text-xs text-slate-400">Toca 🗺️ en cada tarjeta (con dirección exacta) para agregar la parada a la ruta.</div>}
        </div>
      )}

      {filtered.length===0 && <div className="text-center py-12 text-slate-400"><div className="mb-3 flex justify-center"><Ico e="👥" size={36} strokeWidth={1.25} className="opacity-40" /></div><div className="text-sm font-bold">No hay registros.</div></div>}
      <div className="space-y-3">
        {filtered.map((c,idx)=>type==="referido"?(
          <div key={`dbref-${idx}-${String(c.id)}`} className="bg-white rounded-2xl border border-[#e8edf3] p-4 shadow-sm relative">

            {/* ANFITRIÓN como tarjeta de cliente: llamable (tel/WS/SMS), con estado e historial propios */}
            {(()=>{
              const anfCard={...c, nombre:c.anfitrion||"(Sin anfitrión)", telefono:c.anfitrion_telefono||"", ciudad:c.anfitrion_ciudad||"", cuenta:c.anfitrion_cuenta||"", direccion:c.anfitrion_direccion||""};
              const patchAnf=(patch)=>setData(p=>p.map(anf=>anf.id===c.id?{...anf,...patch}:anf));
              const saveHistAnf=(entry)=>setData(p=>p.map(anf=>anf.id===c.id?{...anf,historial:[...(anf.historial||[]),entry]}:anf));
              return (
                <ClientRow c={anfCard} type="anfitrion" role={role}
                  onStatusChange={(id,st)=>patchAnf({estado:st})}
                  onEdit={()=>{setEditItem(c);setShowForm(true);}}
                  onSchedule={cc=>openSchedule(cc)}
                  onDelete={()=>{}}
                  onCall={onCallLog}
                  onApptResult={(cc,rid,detail="")=>{
                    const patch = rid==="demo_venta"?{venta:true,resultado:"demo_venta",resultado_detalle:detail}
                      : rid==="demo_no_venta"?{venta:false,resultado:"demo_no_venta",resultado_detalle:detail}
                      : rid==="no_recibio"?{venta:false,resultado:"no_recibio",resultado_detalle:detail}
                      : rid==="no_visito"?{venta:false,resultado:"no_visito",resultado_detalle:detail}
                      : rid==="seguimiento"?{resultado:"seguimiento",resultado_detalle:detail}:{};
                    patchAnf(patch);
                  }}
                  onSaveCallToHistorial={(id,entry)=>saveHistAnf(entry)}
                  onSaveNota={(id,texto)=>{ const conNota=agregarNota({...anfCard},texto,agente); patchAnf({ultimaNota:conNota.ultimaNota, notas:conNota.notas, actualizado:conNota.actualizado}); }}
                  agente={agente} />
              );
            })()}
            {(c.regalo||c.anfitrion_cuenta||c.anfitrion_detalle) && (
              <div className="text-xs text-slate-500 mt-1.5 space-y-0.5 px-1">
                {c.regalo && <div><Ico e="🎁" className="mr-1.5" />{c.regalo}</div>}
                {c.anfitrion_cuenta && <div><Ico e="🔖" className="mr-1.5" />Cuenta: {c.anfitrion_cuenta}</div>}
                {c.anfitrion_detalle && <div><Ico e="📝" className="mr-1.5" />{c.anfitrion_detalle}</div>}
              </div>
            )}

            {/* Resumen de progreso de referidos (para obsequio) */}
            {(()=>{
              const refs=c.referidos||[];
              const citas=refs.filter(r=>r.estado==="verde").length;
              const ventas=refs.filter(r=>r.venta||r.resultado==="venta").length;
              if(refs.length===0) return null;
              const lograObsequio = citas>=4 || ventas>=1;
              return (
                <div className={`mt-2 flex items-center gap-2 flex-wrap text-[10px] font-bold px-2.5 py-1.5 rounded-lg ${lograObsequio?"bg-amber-50 text-amber-700 border border-amber-200":"bg-[#f4f6f9] text-slate-500"}`}>
                  <span>{refs.length} referido(s)</span>
                  <span>· 📅 {citas} cita(s)</span>
                  <span>· 💰 {ventas} venta(s)</span>
                  {lograObsequio && <span className="ml-auto"><Ico e="🎁" className="mr-1.5" />¡Obsequio ganado!</span>}
                </div>
              );
            })()}

            {/* Cada referido como tarjeta completa */}
            <div className="mt-3 space-y-2">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider"><Ico e="👥" className="mr-1.5" />Referidos (cada uno es llamable)</div>
              {(c.referidos||[]).length===0 && <div className="text-xs text-slate-400 italic">Sin referidos aún. Toca ✏️ Editar para agregar.</div>}
              {(c.referidos||[]).map((r,i)=>{
                const refCard={
                  ...r,
                  id:`${c.id}::${i}`,
                  _anfitrion:c.anfitrion||"",
                  _parentesco:r.parentesco||"",
                  nombre:r.nombre||"(Referido sin nombre)",
                };
                const patchRef=(patch)=>setData(p=>p.map(anf=>{
                  if(anf.id!==c.id) return anf;
                  const refs=[...(anf.referidos||[])];
                  refs[i]={...refs[i],...patch};
                  return {...anf,referidos:refs};
                }));
                const saveHist=(entry)=>setData(p=>p.map(anf=>{
                  if(anf.id!==c.id) return anf;
                  const refs=[...(anf.referidos||[])];
                  refs[i]={...refs[i],historial:[...(refs[i].historial||[]),entry]};
                  return {...anf,referidos:refs};
                }));
                return (
                  <ClientRow key={i} c={refCard} type="referido-llamada" role={role}
                    onStatusChange={(id,st)=>patchRef({estado:st})}
                    onEdit={()=>{setEditItem(c);setShowForm(true);}}
                    onSchedule={cc=>openSchedule(cc)}
                    onDelete={()=>{}}
                    onCall={onCallLog}
                    onApptResult={(cc,rid,detail="")=>{
                      const patch = rid==="demo_venta"?{venta:true,resultado:"demo_venta",resultado_detalle:detail}
                        : rid==="demo_no_venta"?{venta:false,resultado:"demo_no_venta",resultado_detalle:detail}
                        : rid==="no_recibio"?{venta:false,resultado:"no_recibio",resultado_detalle:detail}
                        : rid==="no_visito"?{venta:false,resultado:"no_visito",resultado_detalle:detail}
                        : rid==="seguimiento"?{resultado:"seguimiento",resultado_detalle:detail}:{};
                      patchRef(patch);
                    }}
                    onSaveCallToHistorial={(id,entry)=>saveHist(entry)}
                    onSaveNota={(id,texto)=>{
                      const refActual={...refCard};
                      const conNota=agregarNota(refActual,texto,agente);
                      patchRef({ultimaNota:conNota.ultimaNota, notas:conNota.notas, actualizado:conNota.actualizado});
                    }}
                    agente={agente} />
                );
              })}
            </div>

            <div className="flex gap-1.5 mt-3"><button onClick={()=>{setEditItem(c);setShowForm(true);}} className="text-xs px-3 py-1.5 rounded-md bg-[#f4f6f9] text-slate-700 font-bold border border-[#e5def4]"><Ico e="✏" className="mr-1.5" />Editar anfitrión / referidos</button><button onClick={()=>setData(p=>p.filter(x=>x.id!==c.id))} className="text-xs px-3 py-1.5 rounded-md bg-red-50 text-red-500 font-bold"><Ico e="🗑" /></button></div>
          </div>
        ):(
          <ClientRow key={`db-${idx}-${type}-${String(c.id)}`} c={c} type={type} role={role} infoCobranza={cobranzaClientes ? cobranzaClientes[String(c.id)] : null} onStatusChange={(id,st)=>setData(p=>p.map(x=>x.id===id?{...x,estado:st}:x))} onEdit={c=>{setEditItem(c);setShowForm(true);}} onSchedule={c=>openSchedule(c)} onDelete={id=>setData(p=>p.map(x=>x.id===id?{...x,eliminado:true}:x))} onRestore={id=>setData(p=>p.map(x=>x.id===id?{...x,eliminado:false}:x))} onHardDelete={id=>setData(p=>p.filter(x=>x.id!==id))} inPapelera={showPapelera} onCall={onCallLog} onApptResult={handleApptResult} onSaveCallToHistorial={(id,entry)=>setData(p=>addHistorialEntry(p,id,entry))} onSaveNota={(id,texto)=>setData(p=>p.map(x=>x.id===id?agregarNota(x,texto,agente):x))} onToggleRoute={showRoute?toggleRoute:null} isInRoute={routeSel.includes(c.id)} agente={agente} onDeleteHistorial={(cid,ekey)=>setData(p=>deleteHistorialEntry(p,cid,ekey))} />
        ))}
      </div>
      {showForm && <Modal title={`${editItem?"Editar":"Nuevo"} — ${title}`} onClose={()=>{setShowForm(false);setEditItem(null);}}><ClientForm initial={editItem} type={type} onSave={saveNew} onClose={()=>{setShowForm(false);setEditItem(null);}} /></Modal>}
      {scheduleClient && <Modal title="📅 Agendar en Google Calendar" onClose={()=>{setScheduleClient(null);setForceTipo(null);}}><AppointmentForm client={scheduleClient} forceTipo={forceTipo} loading={calLoading} onSave={handleSchedule} onClose={()=>{setScheduleClient(null);setForceTipo(null);}} agenteActivo={agente} /></Modal>}
    </div>
  );
}

// ─── STATS ────────────────────────────────────────────────────
// ─── CITA CARD (expandible: resultado, editar, borrar) ────────
function CitaCard({ a, onUpdate, onDelete, mostrarFecha, esPasada }) {
  const [open,setOpen]=useState(false);
  const [mode,setMode]=useState("");          // "" | "result" | "edit"
  const [detail,setDetail]=useState("");
  const [draft,setDraft]=useState(null);
  const [montoCita,setMontoCita]=useState("");
  const [productoCita,setProductoCita]=useState("");
  const [filtroCita,setFiltroCita]=useState("");
  const [ventaStep,setVentaStep]=useState(false); // panel monto+producto al marcar venta
  const esServicio = a._type==="servicio" || a.tipo==="servicio";
  const servEstado = a.servicioResultado || "pendiente"; // pendiente | realizado | no_realizado
  const resInfo = RESULTADO_STYLE[a.resultado];
  const fechaObj = a.fecha ? new Date(a.fecha) : null;
  const horaStr = fechaObj ? fechaObj.toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"}) : "";
  const fechaStr = fechaObj ? fechaObj.toLocaleDateString("es-MX",{weekday:"short",day:"numeric",month:"short"}) : "";

  const startEdit = () => {
    setDraft({ nombre:a.nombre||"", telefono:a.telefono||"", direccion:a.direccion||"", fecha:(a.fecha||"").slice(0,16), notas:a.notas||"" });
    setMode("edit");
  };
  const saveEdit = () => { onUpdate({ ...a, ...draft }); setMode(""); };
  const setRes = (id) => {
    if(id==="reset"){ setDetail(""); setMontoCita(""); setProductoCita(""); setFiltroCita(""); setVentaStep(false); startEdit(); return; }
    if(id==="demo_venta"){
      const prod = resolveProducto(productoCita, filtroCita);
      onUpdate({ ...a, resultado:id, resultado_detalle:detail||a.resultado_detalle||"", monto:Number(montoCita)||0, producto:prod.label, cartucho_meses:prod.meses });
    } else {
      onUpdate({ ...a, resultado:id, resultado_detalle:detail||a.resultado_detalle||"" });
    }
    setMode(""); setDetail(""); setMontoCita(""); setProductoCita(""); setFiltroCita(""); setVentaStep(false);
  };
  // Servicio: marca resultado en el MISMO appt (sincroniza con la pestaña Servicio)
  const setServRes = (resultado) => {
    const histPrev=a.servicioHistorial||[];
    onUpdate({ ...a, servicioResultado:resultado, servicioHistorial:[...histPrev,{resultado,fecha:new Date().toISOString(),agente:a.agente||""}], actualizado:new Date().toISOString() });
  };

  return (
    <div className="px-4 py-3">
      {/* Fila compacta */}
      <div className="flex items-center gap-3 cursor-pointer select-none" onClick={()=>setOpen(p=>!p)}>
        <div className="text-lg w-7 text-center shrink-0">{TIPO_ICON[a._type]||"📋"}</div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm text-[#1f2d3d] truncate">{a.nombre}</div>
          <div className="text-xs text-slate-400">
            {mostrarFecha && fechaStr ? <span className="font-bold text-slate-500">{fechaStr} · </span> : null}
            {horaStr}{a.direccion?` · ${a.direccion}`:""}
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {/* Servicio: indicador verde (realizado) / rojo (no realizado o pendiente) */}
            {esServicio ? (
              servEstado==="realizado" ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md text-white" style={{background:"#16a34a"}}><Ico e="✅" className="mr-1.5" />Se realizó</span>
              ) : servEstado==="no_realizado" ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md text-white" style={{background:"#dc2626"}}><Ico e="❌" className="mr-1.5" />No se realizó</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md text-white" style={{background:"#dc2626"}}><Ico e="🔧" className="mr-1.5" />Servicio pendiente</span>
              )
            ) : (
              <>
                {resInfo && <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md" style={resInfo.style}>{resInfo.label}</span>}
                {esPasada && !a.resultado && <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-amber-100 text-amber-700"><Ico e="⏰" className="mr-1.5" />Sin resultado</span>}
              </>
            )}
          </div>
        </div>
        {a.telefono && <div onClick={e=>e.stopPropagation()}><CallMenu telefono={a.telefono} compact /></div>}
        <span className={`text-slate-400 text-sm transition-transform duration-200 shrink-0 ${open?"rotate-180":""}`}>▾</span>
      </div>

      {/* Panel expandido */}
      {open && (
        <div className="mt-2 pl-10">
          {mode==="" && (
            <>
              {/* Servicio: botones de resultado directos (Se realizó / No se realizó) */}
              {esServicio ? (
                <>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <button onClick={()=>setServRes("realizado")}
                      className={`px-3 py-2.5 rounded-lg text-xs font-bold transition ${servEstado==="realizado"?"text-white ring-2 ring-offset-1 ring-emerald-500":"text-emerald-700 bg-emerald-50"}`}
                      style={servEstado==="realizado"?{background:"#16a34a"}:{}}><Ico e="✅" className="mr-1.5" />Se realizó</button>
                    <button onClick={()=>setServRes("no_realizado")}
                      className={`px-3 py-2.5 rounded-lg text-xs font-bold transition ${servEstado==="no_realizado"?"text-white ring-2 ring-offset-1 ring-red-500":"text-red-700 bg-red-50"}`}
                      style={servEstado==="no_realizado"?{background:"#dc2626"}:{}}><Ico e="❌" className="mr-1.5" />No se realizó</button>
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    <button onClick={startEdit} className="flex-1 text-xs font-bold py-2 px-3 rounded-lg bg-[#f4f6f9] text-slate-600"><Ico e="✏" className="mr-1.5" />Editar</button>
                    <button onClick={()=>{if(confirm("¿Borrar este servicio? No se puede deshacer."))onDelete(a.id);}} className="text-xs font-bold py-2 px-3 rounded-lg bg-red-50 text-red-500"><Ico e="🗑" className="mr-1.5" />Borrar</button>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-2"><Ico e="🔄" className="mr-1.5" />El resultado se sincroniza con la pestaña Servicio.</div>
                </>
              ) : (
                <div className="flex gap-1.5 flex-wrap">
                  <button onClick={()=>setMode("result")} className="flex-1 text-xs font-bold py-2 px-2 rounded-lg" style={{background:"#f1ecfd",color:RP.navy}}><Ico e="🎯" className="mr-1.5" />Resultado</button>
                  <button onClick={startEdit} className="text-xs font-bold py-2 px-3 rounded-lg bg-[#f4f6f9] text-slate-600"><Ico e="✏" className="mr-1.5" />Editar</button>
                  <button onClick={()=>{if(confirm("¿Borrar esta cita? No se puede deshacer."))onDelete(a.id);}} className="text-xs font-bold py-2 px-3 rounded-lg bg-red-50 text-red-500"><Ico e="🗑" className="mr-1.5" />Borrar</button>
                </div>
              )}
              {a.notas && <div className="text-xs text-slate-400 italic mt-2">"{a.notas}"</div>}
              {a.resultado_detalle && <div className="text-[#5b21b6] text-xs bg-[#5b21b6]/6 rounded-lg px-2 py-1 mt-2"><Ico e="📝" className="mr-1.5" />{a.resultado_detalle}</div>}
            </>
          )}

          {/* Registrar resultado */}
          {mode==="result" && (
            <div className="rounded-xl overflow-hidden border border-[#5b21b6]/15">
              <div className="px-3 py-2 text-xs font-bold text-white tracking-wide uppercase" style={{background:RP.navy}}><Ico e="🎯" className="mr-1.5" />Resultado de la cita</div>
              <div className="p-2 bg-[#f1ecfd]">
                <textarea className="w-full border-2 border-[#e5def4] bg-white rounded-lg px-3 py-2 text-sm text-[#1f2d3d] focus:outline-none focus:border-[#5b21b6] resize-none placeholder:text-slate-400 mb-2"
                  rows={2} maxLength={300} placeholder="Detalle del resultado (opcional)…"
                  value={detail} onChange={e=>setDetail(e.target.value)} />
                {!ventaStep ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      {APPT_RESULTS.map(r=>(
                        <button key={r.id} onClick={()=>{ if(r.id==="demo_venta"){ setVentaStep(true); } else { setRes(r.id); } }}
                          style={{background:r.bg,color:r.text}}
                          className="flex items-center justify-center text-center px-3 py-3 rounded-lg text-sm font-bold shadow-sm hover:brightness-105 active:scale-95 transition">
                          {r.label}
                        </button>
                      ))}
                    </div>
                    <button onClick={()=>{setMode("");setDetail("");}} className="w-full mt-2 text-xs font-semibold text-slate-500 py-1.5">Cancelar</button>
                  </>
                ) : (
                  <div className="p-2.5 rounded-xl border-2 border-emerald-300 bg-emerald-50">
                    <div className="text-[11px] font-black text-emerald-700 uppercase tracking-wider mb-2"><Ico e="💵" className="mr-1.5" />¿Cuánto fue la venta?</div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-base font-bold text-slate-500">$</span>
                      <input type="number" value={montoCita} onChange={e=>setMontoCita(e.target.value)}
                        className="flex-1 border-2 border-emerald-400 bg-white rounded-lg px-3 py-2 text-base font-bold text-emerald-800 focus:outline-none focus:border-emerald-600 placeholder:text-slate-300"
                        placeholder="0.00" min="0" step="0.01" autoFocus />
                    </div>
                    <div className="text-[11px] font-black text-emerald-700 uppercase tracking-wider mb-1.5"><Ico e="📦" className="mr-1.5" />¿Qué producto vendió?</div>
                    <select value={productoCita} onChange={e=>{setProductoCita(e.target.value); setFiltroCita("");}}
                      className="w-full border-2 border-emerald-400 bg-white rounded-lg px-3 py-2 text-sm font-bold text-emerald-800 focus:outline-none focus:border-emerald-600 mb-2">
                      <option value="">— Selecciona el producto —</option>
                      {PRODUCTOS_VENTA.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                    {productoCita==="filtros" && (
                      <select value={filtroCita} onChange={e=>setFiltroCita(e.target.value)}
                        className="w-full border-2 border-emerald-400 bg-white rounded-lg px-3 py-2 text-sm font-bold text-emerald-800 focus:outline-none focus:border-emerald-600 mb-2">
                        <option value="">— Tipo de filtro —</option>
                        {PRODUCTOS_VENTA.find(p=>p.id==="filtros").sub.map(s=><option key={s.id} value={s.id}>{s.label} (cada {s.meses} meses)</option>)}
                      </select>
                    )}
                    {productoCita==="filtros" && filtroCita && (
                      <div className="text-[10px] text-emerald-600 mb-2"><Ico e="🔔" className="mr-1.5" />Te avisaré cuando toque el cambio de cartucho.</div>
                    )}
                    {productoCita==="purificador" && (
                      <div className="text-[10px] text-emerald-600 mb-2"><Ico e="🔔" className="mr-1.5" />Te avisaré cada año para su mantenimiento.</div>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={()=>{setVentaStep(false);setMontoCita("");setProductoCita("");setFiltroCita("");}}
                        className="px-3 py-2 rounded-lg text-xs font-bold bg-white border border-slate-200 text-slate-500">Atrás</button>
                      <button onClick={()=>setRes("demo_venta")}
                        className="px-3 py-2 rounded-lg text-xs font-bold text-white" style={{background:"#047857"}}><Ico e="💰" className="mr-1.5" />Confirmar venta {montoCita?`$${montoCita}`:""}</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Editar cita */}
          {mode==="edit" && draft && (
            <div className="space-y-2 bg-[#f4f6f9] rounded-xl p-3 border border-[#e5def4]">
              <input className={inpLight} placeholder="Nombre" value={draft.nombre} onChange={e=>setDraft(d=>({...d,nombre:e.target.value}))} />
              <div className="grid grid-cols-2 gap-2">
                <input className={inpLight} placeholder="Teléfono" value={draft.telefono} onChange={e=>setDraft(d=>({...d,telefono:e.target.value}))} />
                <input type="datetime-local" className={inpLight} value={draft.fecha} onChange={e=>setDraft(d=>({...d,fecha:e.target.value}))} />
              </div>
              <input className={inpLight} placeholder="Dirección" value={draft.direccion} onChange={e=>setDraft(d=>({...d,direccion:e.target.value}))} />
              <textarea className={inpLight+" resize-none"} rows={2} placeholder="Notas" value={draft.notas} onChange={e=>setDraft(d=>({...d,notas:e.target.value}))} />
              <div className="flex gap-2">
                <button onClick={saveEdit} className="flex-1 px-3 py-2 rounded-lg text-sm font-bold text-white" style={{background:RP.navy}}><Ico e="💾" className="mr-1.5" />Guardar</button>
                <button onClick={()=>setMode("")} className="px-3 py-2 rounded-lg text-sm font-semibold text-slate-500">Cancelar</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── SISTEMA DE NOTIFICACIONES ────────────────────────────────
// Notificaciones guardadas en Firebase para que todos las vean en tiempo real.
// Estructura: { id, tipo, titulo, detalle, seccion, agente, fecha, leidoPor:[] }

function useNotificaciones(state, setState, agenteActivo) {
  // Contar no leídas (enviadas por otro agente y que yo no he leído)
  const notifs = state.notificaciones || [];
  const noLeidas = notifs.filter(n =>
    n.agente !== agenteActivo &&
    !(n.leidoPor||[]).includes(agenteActivo)
  ).length;

  // Agregar nueva notificación a Firebase (vía setState compartido)
  const notify = (tipo, titulo, detalle, seccion) => {
    const nueva = {
      id: Date.now()+"_"+Math.random().toString(36).slice(2,5),
      tipo,                          // "datos" | "resultado"
      titulo,
      detalle,
      seccion: seccion || "",
      agente: agenteActivo,
      fecha: new Date().toISOString(),
      leidoPor: [agenteActivo],      // quien la creó ya la "leyó"
    };
    setState(s => ({
      ...s,
      notificaciones: [nueva, ...(s.notificaciones||[])].slice(0,100)
    }));
    // Notificación nativa del sistema (si el usuario la permitió)
    try {
      if(Notification.permission === "granted") {
        new Notification(titulo, { body: detalle, icon: "/favicon.ico" });
      }
    } catch {}
  };

  // Marcar todas como leídas para este agente
  const marcarLeidas = () => {
    setState(s => ({
      ...s,
      notificaciones: (s.notificaciones||[]).map(n =>
        (n.leidoPor||[]).includes(agenteActivo)
          ? n
          : { ...n, leidoPor: [...(n.leidoPor||[]), agenteActivo] }
      )
    }));
  };

  // Marcar UNA notificación como leída para este agente
  const marcarUnaLeida = (id) => {
    setState(s => ({
      ...s,
      notificaciones: (s.notificaciones||[]).map(n =>
        n.id===id && !(n.leidoPor||[]).includes(agenteActivo)
          ? { ...n, leidoPor: [...(n.leidoPor||[]), agenteActivo] }
          : n
      )
    }));
  };

  return { notifs, noLeidas, notify, marcarLeidas, marcarUnaLeida };
}

// Pedir permiso de notificaciones al sistema (se llama una vez al montar)
function useNotifPermission() {
  useEffect(() => {
    try {
      if(Notification && Notification.permission === "default") {
        Notification.requestPermission();
      }
    } catch {}
  }, []);
}

// Panel de notificaciones (modal)
function NotifPanel({ notifs, agenteActivo, onClose, onMarcarLeidas, onNotifClick, onLimpiar }) {
  const TIPO_ICON = { datos:"📂", resultado:"🎯", obsequio:"🎁", cumple:"🎂", incentivo:"🏆" };
  return (
    <div className="fixed inset-0 z-[200] flex items-end justify-center" onClick={onClose}>
      <div className="fixed inset-0 bg-black/40" />
      <div className="relative bg-white w-full max-w-md rounded-t-3xl shadow-2xl overflow-hidden"
        style={{maxHeight:"80vh"}} onClick={e=>e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#e8edf3]" style={{background:RP.navy}}>
          <span className="text-white font-black text-sm"><Ico e="🔔" className="mr-1.5" />Notificaciones</span>
          <div className="flex gap-2">
            <button onClick={onMarcarLeidas}
              className="text-[10px] text-white/80 font-bold px-2 py-1 rounded-md bg-white/10 hover:bg-white/20">
              <Ico e="✓" className="mr-1.5" />Marcar leídas
            </button>
            {onLimpiar && <button onClick={onLimpiar}
              className="text-[10px] text-white/80 font-bold px-2 py-1 rounded-md bg-white/10 hover:bg-white/20">
              <Ico e="🗑" className="mr-1.5" />Limpiar
            </button>}
            <button onClick={onClose} className="text-white/80 text-lg leading-none">×</button>
          </div>
        </div>
        {/* Lista */}
        <div className="overflow-y-auto" style={{maxHeight:"calc(80vh - 52px)"}}>
          {notifs.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">Sin notificaciones todavía</div>
          ) : notifs.map(n => {
            const leida = (n.leidoPor||[]).includes(agenteActivo);
            const fecha = new Date(n.fecha);
            const fechaStr = fecha.toLocaleDateString("es-MX",{day:"numeric",month:"short"});
            const horaStr  = fecha.toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"});
            return (
              <button key={n.id} onClick={()=>onNotifClick(n)}
                className={`w-full text-left flex gap-3 px-4 py-3 border-b border-[#f4f6f9] transition active:bg-[#f1ecfd] ${leida?"opacity-50":"bg-[#f1ecfd]/60"}`}>
                <div className="mt-0.5 shrink-0"><Ico e={TIPO_ICON[n.tipo]||"🔔"} size={18} /></div>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm text-[#1f2d3d]">{n.titulo}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{n.detalle}</div>
                  <div className="flex gap-2 mt-1 flex-wrap items-center">
                    {n.seccion && <span className="text-[10px] bg-[#5b21b6]/8 text-[#5b21b6] px-1.5 py-0.5 rounded-md font-bold">{n.seccion}</span>}
                    <span className="text-[10px] text-slate-400">{fechaStr} · {horaStr}</span>
                    <span className="text-[10px] text-slate-400">por {n.agente}</span>
                    <span className="text-[10px] text-[#7c3aed] font-bold ml-auto">Ver ›</span>
                  </div>
                </div>
                {!leida && <div className="w-2 h-2 rounded-full bg-[#5b21b6] mt-1.5 shrink-0" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── DASHBOARD "HOY" ──────────────────────────────────────────
// ── Cumpleaños que caen HOY (manuales + base con fecha_cumple), sin duplicados ──
function cumpleanosDeHoy(cumpleanos, allData){
  const hd=new Date(); const mesA=hd.getMonth(), diaA=hd.getDate();
  const pMD=(fc)=>{
    if(!fc) return null; let m,d;
    if(/^\d{4}-\d{2}-\d{2}$/.test(fc)){ const p=fc.split("-"); m=+p[1]-1; d=+p[2]; }
    else if(/^\d{1,2}-\d{1,2}$/.test(fc)){ const p=fc.split("-"); m=+p[0]-1; d=+p[1]; }
    else if(/^\d{1,2}\/\d{1,2}$/.test(fc)){ const p=fc.split("/"); m=+p[0]-1; d=+p[1]; }
    else return null;
    return {mes:m, dia:d};
  };
  const noE=a=>(a||[]).filter(c=>!c.eliminado);
  const base=[...noE(allData?.distribucion),...noE(allData?.agregados),...noE(allData?.prospectos)]
    .filter(c=>c.fecha_cumple).map(c=>({nombre:c.nombre,telefono:c.telefono,fecha_cumple:c.fecha_cumple}));
  const man=(cumpleanos||[]).map(c=>({nombre:c.nombre,telefono:c.telefono,fecha_cumple:c.fecha_cumple}));
  const vistos=new Set();
  return [...man,...base].map(c=>({...c,md:pMD(c.fecha_cumple)}))
    .filter(c=>c.md&&c.md.mes===mesA&&c.md.dia===diaA)
    .filter(c=>{const k=(c.nombre||"")+"|"+((c.telefono||"").replace(/\D/g,"")); if(vistos.has(k))return false; vistos.add(k); return true;});
}
function Dashboard({ allData, appts, setAppts, callLog, agente, goTo, incentivos, cofreConfig, cofreAperturas, abrirCofre, rolActivo, respaldos, registrarRespaldo, cumpleanos }) {
  const todayStr = hoyLocal();
  const flat = [...allData.agregados, ...allData.prospectos, ...allData.distribucion].filter(c=>!c.eliminado);

  // Incentivos activos asignados a este agente (o a todos)
  const misIncentivos = (incentivos||[]).filter(i=>i.estado!=="cancelado" && (!i.agente || i.agente===agente));

  // Citas de hoy (de Google Calendar local)
  const citasHoy = (appts||[]).filter(a=>a.fecha?.startsWith(todayStr));

  // Seguimientos vencidos o de hoy (proximo_seguimiento <= hoy)
  const seguimientos = flat.filter(c=>c.proximo_seguimiento && c.proximo_seguimiento <= todayStr);

  // Pendientes de llamar (sin estado o naranja)
  const pendientes = flat.filter(c=>["sin_estado","naranja"].includes(c.estado));

  // Mis clientes (asignados a mí)
  const misClientes = flat.filter(c=>c.asignado_a===agente);

  // Stats de hoy — MISMO conteo que la pestaña Llamadas (historial + callLog)
  const conteoLlam = useMemo(()=>conteoLlamadas(allData, callLog), [allData, callLog]);
  const callsToday = sumDia(conteoLlam[todayStr]);
  const enHoy=(f)=>diaLocal(f)===todayStr;
  const flatHistHoy=[...flat, ...(allData.referidos||[]), ...(allData.referidos||[]).flatMap(r=>r.referidos||[])];
  const ventasHoy = contarVentasDemos({ appts, clientes:flatHistHoy, enP:enHoy }).ventas;

  // ── Datos auxiliares del dashboard ──
  const manana=fmtDiaLocal(new Date(Date.now()+86400000));
  // Servicios pendientes (appts tipo servicio sin resultado realizado/no_realizado)
  const serviciosPendientes=(appts||[]).filter(a=>a.tipo==="servicio" && !["realizado","no_realizado"].includes(a.servicioResultado||""));
  // Citas próximas (mañana en adelante)
  const citasProximas=(appts||[]).filter(a=>a.tipo==="cita" && a.fecha && a.fecha.slice(0,10)>=manana).sort((x,y)=>new Date(x.fecha)-new Date(y.fecha));

  // ── CAMBIOS DE CARTUCHO (recordatorio recurrente por producto vendido) ──
  const flatCartucho = [...flat, ...(allData.referidos||[]).filter(c=>!c.eliminado)];
  const cartuchos = calcularCartuchos(flatCartucho, appts, 30);
  const cartuchosVencidos = cartuchos.filter(x=>x.vencido);
  // Notificación nativa una sola vez por sesión si hay cambios vencidos
  useEffect(()=>{
    if(typeof window==="undefined" || window.__cartuchoNotifShown) return;
    if(cartuchosVencidos.length>0){
      window.__cartuchoNotifShown = true;
      try{
        if(typeof Notification!=="undefined" && Notification.permission==="granted"){
          new Notification("🔔 Cambio de cartucho pendiente", { body:`${cartuchosVencidos.length} cliente(s) probablemente necesitan cambio de cartucho`, icon:"/favicon.ico" });
        }
      }catch(e){}
    }
  },[cartuchosVencidos.length]);

  // ── PRIORIDADES (solo lo de HOY): pendiente por llamar, reset, seguimiento, recordatorio ──
  const appointmentsHoy=(appts||[]).filter(a=>a.fecha && a.fecha.slice(0,10)===todayStr);
  // Los recordatorios de llamada (tipo "llamada"/"recordatorio") YA NO entran a
  // prioridad — Tomas pidió quitarlos. Solo quedan pendientes reales, seguimiento y reset.
  const pendientesLlamarHoy=appointmentsHoy.filter(a=>a.tipo==="pendiente");
  const resetHoy=appointmentsHoy.filter(a=>a.tipo==="reset");
  const seguimientoHoy=appointmentsHoy.filter(a=>a.tipo==="seguimiento");

  // Chips de prioridad — SOLO citas de HOY de esos 4 tipos
  const chips=[
    { id:"pend", icon:"📞", label:"Por llamar", n:pendientesLlamarHoy.length, tab:"agenda", color:"#ea580c" },
    { id:"seg",  icon:"📅", label:"Seguimiento",n:seguimientoHoy.length,      tab:"agenda", color:"#7c3aed" },
    { id:"res",  icon:"🔄", label:"Reset",      n:resetHoy.length,            tab:"agenda", color:"#f59e0b" },
  ].filter(c=>c.n>0);

  // Lista combinada de pendientes de hoy (para mostrarlos en detalle)
  const prioridadesHoy=[...pendientesLlamarHoy,...seguimientoHoy,...resetHoy]
    .sort((a,b)=>new Date(a.fecha||0)-new Date(b.fecha||0));

  const hora = new Date().getHours();
  const saludo = hora<12 ? "Buenos días" : hora<19 ? "Buenas tardes" : "Buenas noches";

  return (
    <div className="space-y-5">
      {/* SALUDO */}
      <div className="rounded-2xl p-5 text-white" style={{background:`linear-gradient(135deg, ${RP.navy}, ${RP.blue})`}}>
        {/* El nombre es tocable: lleva directo a Configuración */}
        <button onClick={()=>goTo&&goTo("config")} className="flex items-center gap-1.5 text-sm opacity-90 font-bold active:opacity-60 transition text-left">
          <span>{saludo}, {agente}</span>
          <span className="text-[10px] bg-white/20 rounded-full px-1.5 py-0.5"><Ico e="⚙" /></span>
        </button>
        <div className="text-xs opacity-75 mt-1">{new Date().toLocaleDateString("es-MX",{weekday:"long",day:"numeric",month:"long"})}</div>
        <div className="flex gap-4 mt-4">
          <div><div className="text-2xl font-black" style={{fontFamily:SERIF}}>{callsToday}</div><div className="text-[10px] opacity-75 uppercase font-bold">Llamadas hoy</div></div>
          <div><div className="text-2xl font-black" style={{fontFamily:SERIF}}>{citasHoy.length}</div><div className="text-[10px] opacity-75 uppercase font-bold">Citas hoy</div></div>
          <div><div className="text-2xl font-black" style={{fontFamily:SERIF}}>{ventasHoy}</div><div className="text-[10px] opacity-75 uppercase font-bold">Ventas hoy</div></div>
        </div>
      </div>

      {/* PANEL DE CONTEO DE DATOS — totales por categoría */}
      {(()=>{
        const noElim=(arr)=>(arr||[]).filter(c=>!c.eliminado);
        const nAgg=noElim(allData.agregados).length;
        const nPros=noElim(allData.prospectos).length;
        const nDist=noElim(allData.distribucion).length;
        // Referidos: contar cada referido individual (no por anfitrión/grupo)
        const nRef=noElim(allData.referidos).reduce((a,anf)=>a+(anf.referidos||[]).length,0);
        const totalDatos=nAgg+nPros+nDist+nRef;
        const card=(emoji,label,n,tab)=>(
          <button onClick={()=>goTo&&goTo(tab)} className="bg-white rounded-xl border border-[#e8edf3] p-3 text-left shadow-sm active:scale-95 transition">
            <div className="text-lg font-black text-[#5b21b6]" style={{fontFamily:SERIF}}>{n}</div>
            <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wide flex items-center gap-1.5"><Ico e={emoji} size={12} />{label}</div>
          </button>
        );
        return (
          <div>
            <div className="rounded-2xl p-4 mb-3 text-white" style={{background:`linear-gradient(135deg, ${RP.navy}, ${RP.blue})`,border:`1px solid ${RP.silver2}`}}>
              <div className="text-[11px] opacity-80 uppercase font-black tracking-wider"><Ico e="📊" className="mr-1.5" />Total de datos</div>
              <div className="text-4xl font-black mt-1" style={{fontFamily:SERIF}}>{totalDatos}</div>
              <div className="text-[11px] opacity-75 mt-0.5">registros en toda la base de datos</div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {card("📥","Clientes (Agregados)",nAgg,"agregados")}
              {card("🤝","Referidos",nRef,"referidos")}
              {card("🌱","Prospectos",nPros,"prospectos")}
              {card("📦","Distribución",nDist,"distribucion")}
            </div>
          </div>
        );
      })()}

      {/* PANEL DE PRIORIDADES (Obj 9) — chips clicables, lo más importante primero */}
      {chips.length>0 && (
        <div className="rounded-2xl bg-white border-2 border-[#5b21b6]/15 p-3 shadow-sm">
          <div className="text-xs font-black text-[#5b21b6] uppercase tracking-wider mb-2 px-1"><Ico e="🎯" className="mr-1.5" />Tus prioridades de hoy</div>
          <div className="grid grid-cols-3 gap-2">
            {chips.map(c=>(
              <button key={c.id} onClick={()=>goTo(c.tab)}
                className="rounded-xl p-2.5 text-left transition active:scale-95 border"
                style={{background:`${c.color}0d`,borderColor:`${c.color}33`}}>
                <div className="flex items-center justify-between mb-0.5">
                  <Ico e={c.icon} size={16} />
                  <span className="text-xl font-black" style={{fontFamily:SERIF,color:c.color}}>{c.n}</span>
                </div>
                <div className="text-[10px] font-bold text-slate-500">{c.label}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* CITAS PRÓXIMAS (mañana en adelante) */}
      {citasProximas.length>0 && (
        <div className="rounded-2xl bg-white border border-[#e8edf3] overflow-hidden shadow-sm">
          <div className="px-4 py-3 flex items-center justify-between bg-[#f1ecfd]">
            <div className="text-sm font-black text-[#5b21b6]"><Ico e="🔜" className="mr-1.5" />Próximas citas</div>
            <span className="text-xs font-black text-white bg-[#7c3aed] px-2 py-0.5 rounded-full">{citasProximas.length}</span>
          </div>
          <div className="divide-y divide-[#f4f6f9] max-h-52 overflow-y-auto">
            {citasProximas.slice(0,5).map(a=>{
              const d=new Date(a.fecha);
              return (
                <button key={a.id} onClick={()=>goTo("agenda")} className="w-full px-4 py-2.5 flex items-center gap-3 text-left hover:bg-[#f4f6f9]">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm text-[#1f2d3d] truncate">{a.nombre||"Cliente"}</div>
                    <div className="text-xs text-slate-400"><Ico e="🗓" className="mr-1.5" />{d.toLocaleDateString("es-MX",{weekday:"short",day:"numeric",month:"short"})} · 🕐 {d.toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"})}</div>
                  </div>
                  <span className="text-[10px] font-bold text-[#7c3aed] shrink-0">Ver →</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* SERVICIOS PENDIENTES */}
      {serviciosPendientes.length>0 && (
        <div className="rounded-2xl bg-white border border-red-200 overflow-hidden shadow-sm">
          <div className="px-4 py-3 flex items-center justify-between bg-red-50">
            <div className="text-sm font-black text-red-700"><Ico e="🔧" className="mr-1.5" />Servicios pendientes</div>
            <span className="text-xs font-black text-white bg-red-500 px-2 py-0.5 rounded-full">{serviciosPendientes.length}</span>
          </div>
          <div className="divide-y divide-[#f4f6f9] max-h-52 overflow-y-auto">
            {serviciosPendientes.slice(0,5).map(a=>{
              const d=a.fecha?new Date(a.fecha):null;
              return (
                <button key={a.id} onClick={()=>goTo("servicio")} className="w-full px-4 py-2.5 flex items-center gap-3 text-left hover:bg-[#f4f6f9]">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm text-[#1f2d3d] truncate">{a.nombre||"Cliente"}</div>
                    <div className="text-xs text-slate-400">{d?`🗓️ ${d.toLocaleDateString("es-MX",{day:"numeric",month:"short"})}`:"Sin fecha"}{a.direccion?` · 📍 ${a.direccion}`:""}</div>
                  </div>
                  <span className="text-[10px] font-bold text-red-500 shrink-0">Ver →</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 🎂 CUMPLEAÑOS DE HOY */}
      {(()=>{
        const hoyCumple = cumpleanosDeHoy(cumpleanos, allData);
        if(!hoyCumple.length) return null;
        return (
          <div className="rounded-2xl bg-white border-2 border-pink-200 overflow-hidden shadow-sm">
            <div className="px-4 py-3 bg-pink-50 flex items-center justify-between">
              <div className="text-sm font-black text-pink-600"><Ico e="🎂" className="mr-1.5" />Cumpleaños de hoy</div>
              <span className="text-xs font-black text-white bg-pink-500 px-2 py-0.5 rounded-full">{hoyCumple.length}</span>
            </div>
            <div className="divide-y divide-[#f4f6f9]">
              {hoyCumple.map((c,i)=>(
                  <div key={`cum-${i}`} className="px-4 py-2.5 flex items-center gap-1.5">
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-sm text-[#1f2d3d] truncate">{c.nombre}</div>
                      <div className="text-xs text-slate-400">¡Hoy es su día! 🥳</div>
                    </div>
                    {/* MISMOS enlaces que la pestaña Cumpleaños: número normalizado
                        (waDigitos agrega el 1 de USA) y mismo mensaje de felicitación. */}
                    {c.telefono && <a href={waLinkMsg(c.telefono,c.nombre)} target="_blank" rel="noreferrer" className="text-white text-[11px] font-bold px-2.5 py-1.5 rounded-lg shrink-0" style={{background:"#25D366"}}><Ico e="💬" className="mr-1.5" />WA</a>}
                    {c.telefono && <a href={smsLinkMsg(c.telefono,c.nombre)} className="text-[#5b21b6] text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-[#e5def4] shrink-0">SMS</a>}
                    {c.telefono && <a href={telLink(c.telefono)} className="text-[11px] px-2 py-1.5 rounded-lg border border-[#e5def4] shrink-0"><Ico e="📞" /></a>}
                  </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* MANTENIMIENTOS Y CARTUCHOS PRÓXIMOS / VENCIDOS */}
      {cartuchos.length>0 && (
        <div className="rounded-2xl bg-white border-2 border-teal-200 overflow-hidden shadow-sm">
          <div className="px-4 py-3 bg-teal-50 flex items-center justify-between">
            <div className="text-sm font-black text-teal-700"><Ico e="🔔" className="mr-1.5" />Mantenimientos y cartuchos</div>
            <span className="text-xs font-black text-white bg-teal-500 px-2 py-0.5 rounded-full">{cartuchos.length}</span>
          </div>
          <div className="divide-y divide-[#f4f6f9] max-h-64 overflow-y-auto">
            {cartuchos.slice(0,12).map((x,i)=>{
              const tel=(x.telefono||"").replace(/\D/g,"");
              return (
                <div key={`cart-${i}`} className="px-4 py-2.5 flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm text-[#1f2d3d] truncate">{x.nombre}</div>
                    <div className="text-xs text-slate-400 truncate">
                      {x.producto||"Filtro"} · {x.vencido
                        ? <span className="text-red-500 font-bold"><Ico e="⚠" className="mr-1.5" />Vencido {Math.abs(x.diasFaltan)} d</span>
                        : <span className="text-teal-600 font-bold">en {x.diasFaltan} d</span>} · 🗓️ {x.proxFecha.toLocaleDateString("es-MX",{day:"numeric",month:"short",year:"numeric"})}
                    </div>
                  </div>
                  {tel && <a href={`tel:${tel}`} className="w-8 h-8 flex items-center justify-center rounded-lg text-white text-sm shrink-0" style={{background:RP.blue}}><Ico e="📞" /></a>}
                  {tel && <a href={`https://wa.me/${tel}?text=${encodeURIComponent(`¡Hola ${(x.nombre||"").split(" ")[0]}! 👋 Le saluda su equipo de Royal Prestige. Le corresponde el ${x.vencido?"cambio (ya vencido)":"próximo cambio"} de: ${x.producto||"su filtro"} 💧 ¿Le agendamos su visita de mantenimiento?`)}`} target="_blank" rel="noreferrer" className="w-8 h-8 flex items-center justify-center rounded-lg text-white text-sm shrink-0" style={{background:"#25D366"}}>💬</a>}
                </div>
              );
            })}
          </div>
          <div className="px-4 py-2 text-[10px] text-slate-400 bg-[#f4f6f9]">Se cuenta desde la fecha de venta y se repite en cada ciclo de cambio.</div>
        </div>
      )}

      {/* RESPALDO MENSUAL (solo distribuidor/admin) */}
      <RespaldoBox allData={allData} appts={appts} callLog={callLog} respaldos={respaldos} registrarRespaldo={registrarRespaldo} rolActivo={rolActivo} />

      {/* COFRE IMPACT SEMANAL (por agente) */}
      <CofreSemanal cofreConfig={cofreConfig} cofreAperturas={cofreAperturas} agente={agente} allData={allData} onAbrir={abrirCofre} />

      {/* INCENTIVOS ACTIVOS DEL AGENTE */}
      {misIncentivos.length>0 && misIncentivos.map(inc=>(
        inc.tipo==="racha"
          ? <RachaProgreso key={inc.id} inc={inc} allData={allData} />
          : <IncentivoProgreso key={inc.id} inc={inc} allData={allData} />
      ))}

      {/* SEGUIMIENTOS VENCIDOS — lo más urgente */}
      {seguimientos.length>0 && (
        <div className="rounded-2xl bg-white border-2 border-orange-200 overflow-hidden shadow-sm">
          <div className="px-4 py-3 bg-orange-50 flex items-center justify-between">
            <div className="text-sm font-black text-orange-700"><Ico e="⏰" className="mr-1.5" />Seguimientos pendientes</div>
            <span className="text-xs font-black text-white bg-orange-500 px-2 py-0.5 rounded-full">{seguimientos.length}</span>
          </div>
          <div className="divide-y divide-[#f4f6f9] max-h-64 overflow-y-auto">
            {seguimientos.slice(0,8).map(c=>{
              const vencido = c.proximo_seguimiento < todayStr;
              return (
                <div key={c.id} className="px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm text-[#1f2d3d] truncate">{c.nombre}</div>
                    <div className="text-xs text-slate-400">{vencido?<><Ico e="🔴" className="mr-1" />Vencido</>:<><Ico e="🟠" className="mr-1" />Hoy</>} · {c.proximo_seguimiento}{c.asignado_a?` · ${c.asignado_a}`:""}</div>
                  </div>
                  {c.telefono && <a href={telLink(c.telefono)} className="text-white text-xs font-bold px-3 py-1.5 rounded-md shrink-0" style={{background:RP.blue}}><Ico e="📞" /></a>}
                  {c.telefono && <a href={waLink(c.telefono)} target="_blank" rel="noreferrer" className="text-white text-xs font-bold px-3 py-1.5 rounded-md shrink-0" style={{background:"#25D366"}}><Ico e="💬" /></a>}
                  {c.telefono && <a href={smsLink(c.telefono)} className="text-white text-xs font-bold px-3 py-1.5 rounded-md shrink-0" style={{background:"#7c3aed"}}><Ico e="✉" /></a>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* CITAS DE HOY */}
      <div className="rounded-2xl bg-white border border-[#e8edf3] overflow-hidden shadow-sm">
        <div className="px-4 py-3 flex items-center justify-between" style={{background:RP.navy}}>
          <div className="text-sm font-black text-white"><Ico e="📅" className="mr-1.5" />Tus citas de hoy</div>
          <span className="text-xs font-black text-[#5b21b6] bg-white px-2 py-0.5 rounded-full">{citasHoy.length}</span>
        </div>
        {citasHoy.length===0 ? (
          <div className="px-4 py-6 text-center text-sm text-slate-400">No hay citas agendadas para hoy</div>
        ) : (
          <div className="divide-y divide-[#f4f6f9]">
            {citasHoy.map(a=>(
              <CitaCard key={a.id} a={a}
                onUpdate={u=>setAppts(p=>p.map(x=>x.id===u.id?u:x))}
                onDelete={id=>setAppts(p=>p.filter(x=>x.id!==id))} />
            ))}
          </div>
        )}
      </div>

      {/* ACCESOS RÁPIDOS */}
      <div className="grid grid-cols-2 gap-3">
        <button onClick={()=>goTo("llamadas")} className="rounded-2xl bg-white border border-[#e8edf3] p-4 text-left shadow-sm hover:border-[#7c3aed] transition">
          <div className="text-2xl mb-1"><Ico e="📞" /></div>
          <div className="text-2xl font-black text-[#5b21b6]" style={{fontFamily:SERIF}}>{pendientes.length}</div>
          <div className="text-xs font-bold text-slate-400">Por llamar</div>
        </button>
        <button onClick={()=>goTo("agenda")} className="rounded-2xl bg-white border border-[#e8edf3] p-4 text-left shadow-sm hover:border-[#7c3aed] transition">
          <div className="text-2xl mb-1"><Ico e="📅" /></div>
          <div className="text-2xl font-black text-[#5b21b6]" style={{fontFamily:SERIF}}>+</div>
          <div className="text-xs font-bold text-slate-400">Agendar cita</div>
        </button>
      </div>

      {/* MIS CLIENTES ASIGNADOS */}
      {misClientes.length>0 && (
        <div className="rounded-2xl bg-white border border-[#e8edf3] p-4 shadow-sm">
          <div className="text-sm font-black text-[#1f2d3d] mb-1"><Ico e="👤" className="mr-1.5" />Mis clientes asignados</div>
          <div className="text-3xl font-black text-[#5b21b6]" style={{fontFamily:SERIF}}>{misClientes.length}</div>
          <div className="text-xs text-slate-400 mt-1">Asignados a {agente}</div>
        </div>
      )}
    </div>
  );
}

function Stats({ data, callLog, appts }) {
  const [vista,setVista]=useState("mes");  // "mes" | "historico"
  const flat=[...data.agregados,...data.prospectos,...data.distribucion,...data.referidos];

  // ── Mes seleccionado (default: mes actual) ──
  const now=new Date();
  const [mesSel,setMesSel]=useState(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`);

  // Lista de meses disponibles (de los datos creados + historial + hoy)
  const mesesSet=new Set([mesSel]);
  flat.forEach(c=>{ if(c.creado) mesesSet.add(c.creado.slice(0,7)); (c.historial||[]).forEach(h=>{ if(h.fecha) mesesSet.add(h.fecha.slice(0,7)); }); });
  (appts||[]).forEach(a=>{ if(a.fecha) mesesSet.add(a.fecha.slice(0,7)); });
  const meses=[...mesesSet].sort().reverse();
  const mesLabel=(m)=>{ const [y,mo]=m.split("-"); return new Date(+y,+mo-1,1).toLocaleDateString("es-MX",{month:"long",year:"numeric"}); };

  // ── Métricas del mes seleccionado ──
  const enMes=(fecha)=>fecha&&fecha.slice(0,7)===mesSel;
  // Datos creados en el mes
  const datosMes=flat.filter(c=>enMes(c.creado));
  // Citas del mes (de appts agendadas en el mes)
  const citasMes=(appts||[]).filter(a=>enMes(a.fecha));
  // Ventas del mes (resultado venta registrado en historial del mes, o cita con resultado venta en el mes)
  const flatHist=[...flat, ...(data.referidos||[]).flatMap(r=>r.referidos||[])];
  // Conteo unificado (igual que el panel y la pestaña Llamadas)
  const conteoLlam=conteoLlamadas(data, callLog);
  const llamadasMes=Object.entries(conteoLlam).filter(([k])=>k.slice(0,7)===mesSel).reduce((a,[,v])=>a+sumDia(v),0);
  const _vdMes = contarVentasDemos({ appts, clientes:flatHist, enP:enMes });
  const ventasMes = _vdMes.ventas;
  const demosMes = _vdMes.demos;

  const totalDatosMes=datosMes.length;
  const totalCitasMes=citasMes.length;
  const tasaCitaMes=totalDatosMes>0?Math.round((totalCitasMes/totalDatosMes)*100):0;
  const tasaCierreMes=totalCitasMes>0?Math.round((ventasMes/totalCitasMes)*100):0;
  const tasaCierreDemo=demosMes>0?Math.round((ventasMes/demosMes)*100):0; // % de cierre = ventas / demostraciones
  const tasaCitaDemo=totalCitasMes>0?Math.round((demosMes/totalCitasMes)*100):0; // % de citas que llegaron a demostración
  const llamPorVentaMes=ventasMes>0?(llamadasMes/ventasMes).toFixed(1):"—";

  // (llamadasMes ya sale del conteo unificado — ver arriba)
  const llamadasCallLogMes=llamadasMes;

  // ── Grupos del mes ──
  const groups=[
    {key:"agregados",ico:"📂", label:"Agregados",arr:data.agregados},
    {key:"referidos",ico:"🎁", label:"Referidos",arr:data.referidos},
    {key:"prospectos",ico:"🔍", label:"Prospección",arr:data.prospectos},
    {key:"distribucion",ico:"🏠", label:"Distribución",arr:data.distribucion},
  ];

  // ── HISTÓRICO: métricas por cada mes ──
  const historico=meses.map(m=>{
    const inM=(f)=>f&&f.slice(0,7)===m;
    const d=flat.filter(c=>inM(c.creado)).length;
    const ct=(appts||[]).filter(a=>inM(a.fecha)).length;
    const v=contarVentasDemos({ appts, clientes:flatHist, enP:inM }).ventas;
    const ll=Object.entries(conteoLlam).filter(([k])=>k.slice(0,7)===m).reduce((a,[,x])=>a+sumDia(x),0);
    return {mes:m, datos:d, citas:ct, ventas:v, llamadas:ll};
  });

  // Contador de llamadas últimos 7 días (siempre visible)
  const days=[];for(let i=6;i>=0;i--){const dd=new Date();dd.setDate(dd.getDate()-i);const k=fmtDiaLocal(dd);days.push({k,n:sumDia(conteoLlam[k]),label:dd.toLocaleDateString("es-MX",{weekday:"short"})});}
  const todayKey=hoyLocal();const callsToday=sumDia(conteoLlam[todayKey]);const maxCalls=Math.max(...days.map(d=>d.n),1);

  return (
    <div className="space-y-5">
      {/* Pestañas Mes / Histórico */}
      <div className="flex gap-1.5">
        <button onClick={()=>setVista("mes")}
          className={`flex-1 px-3 py-2.5 rounded-xl text-sm font-bold transition ${vista==="mes"?"text-white":"text-slate-600 bg-[#f4f6f9]"}`}
          style={vista==="mes"?{background:RP.navy}:{}}><Ico e="📅" className="mr-1.5" />Por mes</button>
        <button onClick={()=>setVista("historico")}
          className={`flex-1 px-3 py-2.5 rounded-xl text-sm font-bold transition ${vista==="historico"?"text-white":"text-slate-600 bg-[#f4f6f9]"}`}
          style={vista==="historico"?{background:RP.navy}:{}}><Ico e="📈" className="mr-1.5" />Histórico mensual</button>
      </div>

      {vista==="mes" ? (
        <>
          {/* Selector de mes */}
          <div className="bg-white rounded-2xl p-3 shadow-sm border border-[#e8edf3]">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Mes a mostrar</div>
            <select className="w-full border-2 border-[#e5def4] rounded-lg px-3 py-2 text-sm bg-white font-bold capitalize" value={mesSel} onChange={e=>setMesSel(e.target.value)}>
              {meses.map(m=><option key={m} value={m}>{mesLabel(m)}</option>)}
            </select>
          </div>

          {/* Resumen del mes */}
          <div className="grid grid-cols-3 gap-3">
            {[{l:"Datos",v:totalDatosMes,ic:"👥"},{l:"Citas",v:totalCitasMes,ic:"📅"},{l:"Ventas",v:ventasMes,ic:"💰"}].map(s=>(
              <div key={s.l} className="bg-white rounded-2xl p-4 text-center shadow-sm border border-[#e8edf3]"><div className="text-2xl mb-1">{s.ic}</div><div className="text-3xl font-bold text-[#5b21b6]" style={{fontFamily:SERIF}}>{s.v}</div><div className="text-xs font-bold text-slate-400 uppercase tracking-wide">{s.l}</div></div>
            ))}
          </div>

          {/* Embudo del mes */}
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-[#e8edf3]">
            <div className="text-sm font-bold text-[#1f2d3d] mb-1 capitalize"><Ico e="🎯" className="mr-1.5" />Embudo de conversión — {mesLabel(mesSel)}</div>
            <div className="text-[11px] text-slate-400 mb-3">Cada barra muestra el % que avanzó desde la etapa anterior</div>
            <div className="space-y-2">
              {[
                {label:"Datos del mes",   val:totalDatosMes, pct:100, color:"#5b21b6"},
                {label:"Citas agendadas", val:totalCitasMes, pct:totalDatosMes>0?(totalCitasMes/totalDatosMes)*100:0, color:"#16a34a"},
                {label:"Demostraciones",  val:demosMes,      pct:totalCitasMes>0?(demosMes/totalCitasMes)*100:0,     color:"#0d9488"},
                {label:"Ventas cerradas", val:ventasMes,     pct:demosMes>0?(ventasMes/demosMes)*100:0,               color:"#047857"},
              ].map(f=>(
                <div key={f.label}>
                  <div className="flex justify-between text-xs font-bold mb-1"><span className="text-slate-600">{f.label}</span><span style={{color:f.color}}>{f.val}</span></div>
                  <div className="h-7 rounded-lg bg-[#f4f6f9] overflow-hidden">
                    <div className="h-full rounded-lg flex items-center px-2 text-white text-xs font-black transition-all" style={{width:`${Math.max(f.pct,8)}%`,background:f.color}}>{Math.round(f.pct)}%</div>
                  </div>
                </div>
              ))}
              <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-[#f4f6f9]">
                <div className="text-center"><div className="text-xl font-black text-teal-700">{tasaCitaDemo}%</div><div className="text-[9px] font-bold text-slate-400 uppercase">Cita → Demo</div></div>
                <div className="text-center"><div className="text-xl font-black text-emerald-700">{tasaCierreDemo}%</div><div className="text-[9px] font-bold text-slate-400 uppercase">Demo → Venta</div></div>
              </div>
            </div>
          </div>

          {/* Contador de llamadas 7 días */}
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-[#e8edf3]">
            <div className="flex items-center justify-between mb-3"><div className="text-sm font-bold text-[#1f2d3d]"><Ico e="📞" className="mr-1.5" />Llamadas — últimos 7 días</div><div className="text-white text-xs font-bold px-3 py-1 rounded-full" style={{background:RP.navy}}>HOY: {callsToday}</div></div>
            <div className="flex items-end gap-2 h-28">{days.map(d=>(<div key={d.k} className="flex-1 flex flex-col items-center gap-1"><div className="text-xs font-bold text-slate-500">{d.n}</div><div className="w-full rounded-t-md transition-all" style={{height:`${(d.n/maxCalls)*80}px`,minHeight:"4px",background:RP.blue,opacity:d.k===todayKey?1:0.45}} /><div className="text-[10px] font-bold text-slate-400 capitalize">{d.label}</div></div>))}</div>
          </div>

          {/* Estadísticas por grupo (del mes) */}
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-[#e8edf3]">
            <div className="text-sm font-bold text-[#1f2d3d] mb-3 capitalize"><Ico e="📊" className="mr-1.5" />Por grupo — {mesLabel(mesSel)}</div>
            <div className="text-[11px] text-slate-400 mb-2 -mt-1">% de cierre = ventas ÷ demostraciones · para ver la calidad del dato de cada base</div>
            <div className="space-y-3">{groups.map(g=>{
              const esRef = g.key==="referidos";
              const cards = g.arr||[];
              const clientesG = esRef ? [...cards, ...cards.flatMap(a=>a.referidos||[])] : cards;
              const datos = esRef
                ? cards.reduce((n,anf)=> n + (anf.eliminado?0:(anf.referidos||[]).filter(r=>enMes(r.creado||anf.creado)).length), 0)
                : cards.filter(c=>!c.eliminado && enMes(c.creado)).length;
              const vd = contarVentasDemos({ clientes:clientesG, enP:enMes });
              return (
              <div key={g.key} className="border border-[#e8edf3] rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-bold text-slate-700">{g.label}</div>
                  <div className="text-[11px] font-black text-white px-2 py-0.5 rounded-full" style={{background: vd.demos===0?"#cbd5e1":vd.cierre>=50?"#16a34a":vd.cierre>=25?"#f59e0b":"#94a3b8"}}>{vd.demos===0?"sin demos":`${vd.cierre}% cierre`}</div>
                </div>
                <div className="grid grid-cols-3 gap-2">{[{l:"Datos",v:datos,c:"text-[#5b21b6]"},{l:"Demos",v:vd.demos,c:"text-teal-700"},{l:"Ventas",v:vd.ventas,c:"text-emerald-700"}].map(x=>(<div key={x.l} className="bg-[#f4f6f9] rounded-lg py-2 text-center"><div className={`text-xl font-bold ${x.c}`}>{x.v}</div><div className="text-[10px] font-bold text-slate-400 uppercase">{x.l}</div></div>))}</div>
              </div>);})}</div>
          </div>

          {/* Rendimiento agente de llamadas (del mes) */}
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-[#e8edf3]">
            <div className="text-sm font-bold text-[#1f2d3d] mb-3"><Ico e="📞" className="mr-1.5" />Agente de llamadas — {mesLabel(mesSel)}</div>
            {(()=>{
              const ag="Agente de llamadas";
              let llamadas=0, ventas=0;
              flat.forEach(c=>(c.historial||[]).forEach(h=>{ if(h.agente===ag&&enMes(h.fecha)){ if(h.tipo==="llamada")llamadas++; if(h.cita_resultado==="demo_venta"||h.cita_resultado==="venta")ventas++; } }));
              const citas=citasMes.filter(a=>a.asignado_a===ag||true).length>=0?citasMes.length:0;
              const tasa=llamadas>0?Math.round((totalCitasMes/llamadas)*100):0;
              return (
                <div>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    <div className="bg-[#f4f6f9] rounded-xl py-3 text-center"><div className="text-2xl font-black text-[#5b21b6]" style={{fontFamily:SERIF}}>{llamadas}</div><div className="text-[10px] font-bold text-slate-400 uppercase mt-0.5"><Ico e="📞" className="mr-1.5" />Llamadas</div></div>
                    <div className="bg-[#f4f6f9] rounded-xl py-3 text-center"><div className="text-2xl font-black text-green-700" style={{fontFamily:SERIF}}>{totalCitasMes}</div><div className="text-[10px] font-bold text-slate-400 uppercase mt-0.5"><Ico e="📅" className="mr-1.5" />Citas</div></div>
                    <div className="bg-[#f4f6f9] rounded-xl py-3 text-center"><div className="text-2xl font-black text-emerald-700" style={{fontFamily:SERIF}}>{ventas}</div><div className="text-[10px] font-bold text-slate-400 uppercase mt-0.5"><Ico e="💰" className="mr-1.5" />Ventas</div></div>
                  </div>
                  <div className="rounded-xl p-3 text-white flex items-center justify-between" style={{background:`linear-gradient(135deg, ${RP.navy}, ${RP.blue})`}}>
                    <span className="text-xs font-bold opacity-90">Efectividad: llamadas que generan cita</span>
                    <span className="text-2xl font-black" style={{fontFamily:SERIF}}>{tasa}%</span>
                  </div>
                </div>
              );
            })()}
          </div>
        </>
      ) : (
        /* ── VISTA HISTÓRICO ── */
        <>
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-[#e8edf3]">
            <div className="text-sm font-bold text-[#1f2d3d] mb-1"><Ico e="📈" className="mr-1.5" />Histórico mensual</div>
            <div className="text-xs text-slate-400 mb-4">Resumen de todas tus estadísticas mes a mes</div>
            {historico.length===0 ? (
              <div className="text-center text-sm text-slate-400 py-6">Aún no hay datos históricos</div>
            ) : (
              <div className="space-y-3">
                {historico.map(h=>{
                  const tasaCierre=h.citas>0?Math.round((h.ventas/h.citas)*100):0;
                  return (
                    <div key={h.mes} className="border-2 border-[#e8edf3] rounded-xl overflow-hidden">
                      <div className="px-3 py-2 text-white font-bold text-sm capitalize" style={{background:RP.navy}}>{mesLabel(h.mes)}</div>
                      <div className="grid grid-cols-4 divide-x divide-[#f4f6f9]">
                        <div className="py-3 text-center"><div className="text-xl font-black text-[#5b21b6]" style={{fontFamily:SERIF}}>{h.datos}</div><div className="text-[9px] font-bold text-slate-400 uppercase">Datos</div></div>
                        <div className="py-3 text-center"><div className="text-xl font-black text-orange-600" style={{fontFamily:SERIF}}>{h.llamadas}</div><div className="text-[9px] font-bold text-slate-400 uppercase">Llam.</div></div>
                        <div className="py-3 text-center"><div className="text-xl font-black text-green-700" style={{fontFamily:SERIF}}>{h.citas}</div><div className="text-[9px] font-bold text-slate-400 uppercase">Citas</div></div>
                        <div className="py-3 text-center"><div className="text-xl font-black text-emerald-700" style={{fontFamily:SERIF}}>{h.ventas}</div><div className="text-[9px] font-bold text-slate-400 uppercase">Ventas</div></div>
                      </div>
                      <div className="px-3 py-1.5 bg-[#f4f6f9] text-center text-[10px] font-bold text-slate-500">Cierre: {tasaCierre}% · {h.ventas} venta(s) de {h.citas} cita(s)</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Comparativa de ventas por mes (barras) */}
          {historico.length>1 && (
            <div className="bg-white rounded-2xl p-4 shadow-sm border border-[#e8edf3]">
              <div className="text-sm font-bold text-[#1f2d3d] mb-3"><Ico e="💰" className="mr-1.5" />Ventas por mes</div>
              <div className="flex items-end gap-2 h-32">
                {[...historico].reverse().map(h=>{
                  const maxV=Math.max(...historico.map(x=>x.ventas),1);
                  return (
                    <div key={h.mes} className="flex-1 flex flex-col items-center gap-1">
                      <div className="text-xs font-bold text-emerald-700">{h.ventas}</div>
                      <div className="w-full rounded-t-md transition-all" style={{height:`${(h.ventas/maxV)*90}px`,minHeight:"4px",background:"#047857"}} />
                      <div className="text-[9px] font-bold text-slate-400 capitalize">{h.mes.split("-")[1]}/{h.mes.split("-")[0].slice(2)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── AGENDA ───────────────────────────────────────────────────
const TIPO_BORDER = { cita:"border-l-[#7c3aed]", llamada:"border-l-orange-400", cocinada:"border-l-purple-500", servicio:"border-l-red-500", personal:"border-l-green-500", entrevista:"border-l-teal-500" };
const TIPO_ICON   = { cita:"📋", llamada:"📞", cocinada:"🍳", servicio:"🔧", personal:"🟢", entrevista:"🤝" };
const TIPO_COLOR = { cita:"#5b21b6", llamada:"#ea580c", cocinada:"#7c3aed", servicio:"#dc2626", personal:"#16a34a", entrevista:"#0d9488" };
const MESES_CAL = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const DIAS_CAL  = ["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"];

// ─── CALENDARIO ESTILO GOOGLE CALENDAR (día / semana / mes / año) ───
function CalendarioAgenda({ appts, onUpdate, onDelete }) {
  const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const hoyISO = isoLocal(new Date());
  const [modo,setModo] = useState("mes");            // dia | semana | mes | año
  const [ref,setRef]   = useState(()=>new Date());   // fecha de referencia del periodo
  const [selDia,setSelDia] = useState(hoyISO);       // día seleccionado (vista mes/día)

  // Agrupar citas por día (clave YYYY-MM-DD) y ordenar por hora
  const porDia = useMemo(()=>{
    const m={};
    (appts||[]).forEach(a=>{ const k=(a.fecha||"").slice(0,10); if(k.length===10){ (m[k]=m[k]||[]).push(a); } });
    Object.values(m).forEach(l=>l.sort((x,y)=>(x.fecha||"").localeCompare(y.fecha||"")));
    return m;
  },[appts]);

  const mover = dir => {
    if(modo==="dia"){ const d=new Date(selDia+"T12:00"); d.setDate(d.getDate()+dir); setSelDia(isoLocal(d)); setRef(d); return; }
    const d=new Date(ref);
    if(modo==="semana") d.setDate(d.getDate()+7*dir);
    else if(modo==="mes") d.setMonth(d.getMonth()+dir);
    else d.setFullYear(d.getFullYear()+dir);
    setRef(d);
  };
  const irHoy = ()=>{ const d=new Date(); setRef(d); setSelDia(isoLocal(d)); };

  // Cuadrícula del mes (empieza lunes)
  const celdasMes = base => {
    const y=base.getFullYear(), m=base.getMonth();
    const offset=(new Date(y,m,1).getDay()+6)%7;
    const nDias=new Date(y,m+1,0).getDate();
    const celdas=[];
    for(let i=0;i<offset;i++) celdas.push(null);
    for(let d=1;d<=nDias;d++) celdas.push(new Date(y,m,d));
    while(celdas.length%7!==0) celdas.push(null);
    return celdas;
  };
  const semanaDias = () => { const lun=lunesDeLaSemana(ref); return Array.from({length:7},(_,i)=>{const d=new Date(lun);d.setDate(d.getDate()+i);return d;}); };

  const etiqueta = modo==="dia"
    ? new Date(selDia+"T12:00").toLocaleDateString("es",{weekday:"long",day:"numeric",month:"long",year:"numeric"})
    : modo==="semana"
    ? (()=>{const ds=semanaDias();return `${ds[0].getDate()} ${MESES_CAL[ds[0].getMonth()].slice(0,3)} – ${ds[6].getDate()} ${MESES_CAL[ds[6].getMonth()].slice(0,3)} ${ds[6].getFullYear()}`;})()
    : modo==="mes"
    ? `${MESES_CAL[ref.getMonth()]} ${ref.getFullYear()}`
    : String(ref.getFullYear());

  const cardsDe = (arr, mostrarFecha=false) => arr.map(a=>{
    const esPasada=a.fecha && a.fecha<new Date().toISOString() && !(a.fecha||"").startsWith(hoyISO);
    return (
      <div key={a.id} className={`bg-white border-2 border-[#e8edf3] border-l-4 rounded-2xl shadow-sm ${TIPO_BORDER[a._type||a.tipo]||"border-l-slate-300"}`}>
        <CitaCard a={a} mostrarFecha={mostrarFecha} esPasada={esPasada} onUpdate={onUpdate} onDelete={onDelete} />
      </div>
    );
  });

  const Dot = ({t}) => <span className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0" style={{background:TIPO_COLOR[t]||"#94a3b8"}} />;

  return (
    <div>
      {/* Selector día / semana / mes / año */}
      <div className="grid grid-cols-4 gap-1.5 mb-3">
        {[["dia","Día"],["semana","Semana"],["mes","Mes"],["año","Año"]].map(([v,l])=>(
          <button key={v} onClick={()=>setModo(v)}
            className={`py-2 rounded-lg text-xs font-bold transition ${modo===v?"text-white":"text-slate-600 bg-[#f4f6f9]"}`}
            style={modo===v?{background:RP.navy}:{}}>{l}</button>
        ))}
      </div>

      {/* Navegación ‹ Hoy › */}
      <div className="flex items-center justify-between gap-2 mb-3 bg-white rounded-xl border border-[#e8edf3] px-2 py-2 shadow-sm">
        <button onClick={()=>mover(-1)} className="w-9 h-9 flex-shrink-0 rounded-lg text-lg font-bold text-slate-600 bg-[#f4f6f9] hover:brightness-95">‹</button>
        <div className="text-sm font-black text-center capitalize flex-1 min-w-0" style={{color:RP.navy}}>{etiqueta}</div>
        <div className="flex gap-1.5 flex-shrink-0">
          <button onClick={irHoy} className="px-3 h-9 rounded-lg text-xs font-bold text-white hover:brightness-110" style={{background:RP.blue}}>Hoy</button>
          <button onClick={()=>mover(1)} className="w-9 h-9 rounded-lg text-lg font-bold text-slate-600 bg-[#f4f6f9] hover:brightness-95">›</button>
        </div>
      </div>

      {/* VISTA AÑO */}
      {modo==="año" && (
        <div className="grid grid-cols-3 gap-2">
          {MESES_CAL.map((nm,i)=>{
            const pref=`${ref.getFullYear()}-${String(i+1).padStart(2,"0")}`;
            const n=Object.keys(porDia).filter(k=>k.startsWith(pref)).reduce((sum,k)=>sum+porDia[k].length,0);
            const esMesActual=pref===hoyISO.slice(0,7);
            return (
              <button key={nm} onClick={()=>{setRef(new Date(ref.getFullYear(),i,1));setModo("mes");}}
                className={`p-3 rounded-xl border text-center transition bg-white shadow-sm hover:brightness-95 ${esMesActual?"border-[#7c3aed] ring-1 ring-[#a78bfa]":"border-[#e8edf3]"}`}>
                <div className="text-xs font-black" style={{color:RP.navy}}>{nm.slice(0,3)}</div>
                <div className={`text-[10px] mt-1 font-bold ${n?"text-[#7c3aed]":"text-slate-300"}`}>{n?`${n} cita${n>1?"s":""}`:"—"}</div>
              </button>
            );
          })}
        </div>
      )}

      {/* VISTA MES */}
      {modo==="mes" && (()=>{
        const celdas=celdasMes(ref);
        const citasSel=porDia[selDia]||[];
        return (
          <div>
            <div className="bg-white rounded-2xl border border-[#e8edf3] shadow-sm p-2">
              <div className="grid grid-cols-7 mb-1">
                {DIAS_CAL.map(d=><div key={d} className="text-center text-[10px] font-bold text-slate-400 py-1">{d}</div>)}
              </div>
              <div className="grid grid-cols-7 gap-0.5">
                {celdas.map((d,i)=>{
                  if(!d) return <div key={"v"+i} />;
                  const iso=isoLocal(d);
                  const citas=porDia[iso]||[];
                  const esHoy=iso===hoyISO, esSel=iso===selDia;
                  return (
                    <button key={iso} onClick={()=>setSelDia(iso)}
                      className={`relative rounded-lg pt-1 pb-1.5 min-h-[46px] flex flex-col items-center transition border ${esSel?"border-[#7c3aed]":"border-transparent"} ${esHoy&&!esSel?"bg-[#ede9fe]":""}`}
                      style={esSel?{background:RP.navy}:{}}>
                      <span className={`text-xs font-bold ${esSel?"text-white":esHoy?"text-[#5b21b6]":"text-slate-700"}`}>{d.getDate()}</span>
                      <span className="flex gap-0.5 mt-1 flex-wrap justify-center px-0.5">
                        {citas.slice(0,3).map((a,j)=><Dot key={j} t={a._type||a.tipo} />)}
                        {citas.length>3 && <span className={`text-[8px] font-bold leading-none ${esSel?"text-white":"text-slate-400"}`}>+{citas.length-3}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex gap-2.5 flex-wrap mt-2 px-1">
              {TYPE_OPTIONS.map(o=>(
                <span key={o.v} className="flex items-center gap-1 text-[9px] font-bold text-slate-500"><Dot t={o.v}/>{o.l.replace(/^\S+\s/,"")}</span>
              ))}
            </div>
            <div className="mt-3">
              <div className="text-xs font-black mb-2 capitalize" style={{color:RP.navy}}>
                📌 {new Date(selDia+"T12:00").toLocaleDateString("es",{weekday:"long",day:"numeric",month:"long"})} · {citasSel.length} cita{citasSel.length!==1?"s":""}
              </div>
              {citasSel.length===0
                ? <div className="bg-white rounded-2xl p-6 text-center text-sm text-slate-400 shadow-sm border border-[#e8edf3]">Sin citas este día</div>
                : <div className="space-y-2">{cardsDe(citasSel)}</div>}
            </div>
          </div>
        );
      })()}

      {/* VISTA SEMANA */}
      {modo==="semana" && (
        <div className="space-y-3">
          {semanaDias().map(d=>{
            const iso=isoLocal(d);
            const citas=porDia[iso]||[];
            const esHoy=iso===hoyISO;
            return (
              <div key={iso}>
                <div className="flex items-center gap-2 mb-1.5 px-1">
                  <span className={`text-xs font-black capitalize ${esHoy?"text-white px-2 py-0.5 rounded-full":"text-slate-600"}`} style={esHoy?{background:RP.blue}:{}}>
                    {DIAS_CAL[(d.getDay()+6)%7]} {d.getDate()}
                  </span>
                  <span className="text-[10px] text-slate-400 font-bold">{citas.length?`${citas.length} cita${citas.length>1?"s":""}`:"libre"}</span>
                </div>
                {citas.length>0 && <div className="space-y-2">{cardsDe(citas)}</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* VISTA DÍA */}
      {modo==="dia" && (()=>{
        const citas=porDia[selDia]||[];
        return citas.length===0
          ? <div className="bg-white rounded-2xl p-8 text-center text-sm text-slate-400 shadow-sm border border-[#e8edf3]">Sin citas este día</div>
          : <div className="space-y-2">{cardsDe(citas)}</div>;
      })()}
    </div>
  );
}

function Agenda({ appts, setAppts, agente, onVentaSync }) {
  const [showForm,setShowForm]=useState(false);const [menuOpen,setMenuOpen]=useState(false);
  const [preType,setPreType]=useState(null);const [calLoading,setCalLoading]=useState(false);const [calMsg,setCalMsg]=useState("");
  const handleSchedule=appt=>{
    setCalMsg("");
    window.open(gcalLink(appt),"_blank");
    setAppts(p=>[{...appt,id:Date.now(),_type:appt.tipo},...p]);
    const cfg=TYPE_OPTIONS.find(t=>t.v===appt.tipo)||TYPE_OPTIONS[0];
    setCalMsg(`✅ ${cfg.l} — "${appt.nombre}" guardada aquí. Se abrió Google Calendar con todo listo: solo toca GUARDAR allá.`);
    setShowForm(false);setPreType(null);
  };
  const openWith=(tipo)=>{setPreType(tipo);setMenuOpen(false);setShowForm(true);};
  const [vista,setVista]=useState("lista"); // lista | calendario
  const [filtro,setFiltro]=useState("hoy");   // hoy | proximas | todas
  const [filtroTipo,setFiltroTipo]=useState("todos");
  const [filtroResultado,setFiltroResultado]=useState("todos");
  const [mostrarFiltros,setMostrarFiltros]=useState(false);
  const [busca,setBusca]=useState("");
  const todayStr=hoyLocal();
  const ahora=new Date().toISOString();

  // Ordenar todas las citas por fecha
  const ordenadas=[...appts].filter(Boolean).sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||""));

  // Filtrar por TIPO de cita (base — se comparte entre lista y calendario)
  let base=ordenadas;
  if(filtroTipo!=="todos"){
    base=base.filter(a=>{
      const t=a.tipo||a._type;
      if(filtroTipo==="llamada") return t==="llamada"||t==="recordatorio"; // "Recordatorio"
      return t===filtroTipo;
    });
  }
  // Filtrar por RESULTADO de la cita
  if(filtroResultado!=="todos"){
    const PROD_KEYS={venta_ducha:["ducha"],venta_cart35:["3.500","3500"],venta_cart55:["5.500","5500"],venta_prefw:["frescaflow","fw"]};
    base=base.filter(a=>{
      if(filtroResultado==="demo_venta")    return a.resultado==="demo_venta"||a.resultado==="venta";
      if(filtroResultado==="demo_no_venta") return a.resultado==="demo_no_venta"||a.resultado==="no_venta";
      if(PROD_KEYS[filtroResultado]){
        const esVenta=a.resultado==="demo_venta"||a.resultado==="venta";
        const lbl=String(a.producto||a.venta_producto||"").toLowerCase();
        return esVenta && PROD_KEYS[filtroResultado].some(k=>lbl.includes(k));
      }
      return a.resultado===filtroResultado;
    });
  }
  // Filtrar por búsqueda (nombre, teléfono o ciudad — sin acentos)
  if(busca.trim()){
    const q=normTexto(busca);
    const qNum=soloNum(busca);
    base=base.filter(a=>normTexto(a.nombre).includes(q)||normTexto(a.ciudad).includes(q)||(qNum&&soloNum(a.telefono).includes(qNum)));
  }
  // Filtrar por categoría (solo para la vista de lista)
  let lista=base;
  if(filtro==="hoy")      lista=base.filter(a=>a.fecha?.startsWith(todayStr));
  else if(filtro==="proximas") lista=base.filter(a=>a.fecha&&a.fecha>ahora&&!a.fecha.startsWith(todayStr));
  // "todas" deja todo

  // Contadores
  const nHoy=ordenadas.filter(a=>a.fecha?.startsWith(todayStr)).length;
  const nProximas=ordenadas.filter(a=>a.fecha&&a.fecha>ahora&&!a.fecha.startsWith(todayStr)).length;
  const sinResultado=ordenadas.filter(a=>{const t=a.tipo||a._type; return t==="cita" && a.fecha && a.fecha<ahora && !a.fecha.startsWith(todayStr) && !a.resultado;}).length;

  const FILTROS=[
    {id:"hoy",      label:"Hoy",      count:nHoy},
    {id:"proximas", label:"Próximas", count:nProximas},
    {id:"todas",    label:"Todas",    count:ordenadas.length},
  ];

  const TIPO_FILTROS=[
    {v:"todos",      label:"Todos"},
    {v:"cita",       ico:"📋", label:"Cita"},
    {v:"llamada",    ico:"🔔", label:"Recordatorio"},
    {v:"cocinada",   ico:"🍳", label:"Cocinada"},
    {v:"servicio",   ico:"🔧", label:"Servicio"},
    {v:"personal",   ico:"🟢", label:"Personal"},
    {v:"entrevista", ico:"🤝", label:"Entrevista"},
  ];
  const RES_FILTROS=[
    {v:"todos",         label:"Todos"},
    {v:"demo_venta",    ico:"💰", label:"Demo venta"},
    {v:"demo_no_venta", ico:"📋", label:"Demo no venta"},
    {v:"no_recibio",    ico:"🚫", label:"No recibió"},
    {v:"no_visito",     ico:"🏠", label:"No se visitó"},
    {v:"seguimiento",   ico:"📅", label:"Seguimiento"},
    {v:"recompra",      ico:"✖", label:"Recompra"},
    {v:"venta_ducha",   ico:"🚿", label:"Ducha (6 meses)"},
    {v:"venta_cart35",  ico:"💧", label:"Frescapure 3.500 (12 meses)"},
    {v:"venta_cart55",  ico:"💧", label:"Frescapure 5.500 (24 meses)"},
    {v:"venta_prefw",   ico:"💧", label:"Frescaflow (6 meses)"},
  ];
  const filtrosActivos=(filtroTipo!=="todos"?1:0)+(filtroResultado!=="todos"?1:0);

  return (
    <div>
      {calMsg && <div className="mb-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-700 font-bold flex items-center justify-between"><Msg>{calMsg}</Msg><button onClick={()=>setCalMsg("")} className="ml-2"><Ico e="✕" /></button></div>}

      {/* ── DROPDOWN TRIGGER ── */}
      <div className="relative mb-4">
        <button onClick={()=>setMenuOpen(p=>!p)}
          className="w-full flex items-center justify-between px-5 py-3.5 rounded-xl text-white font-bold text-sm hover:brightness-110 transition shadow-sm"
          style={{background:RP.navy}}>
          <span><Ico e="📅" className="mr-1.5" />Nueva cita / recordatorio</span>
          <span className={`text-lg transition-transform duration-200 ${menuOpen?"rotate-180":""}`}>▾</span>
        </button>
        {menuOpen && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl shadow-2xl border border-[#e8edf3] overflow-hidden z-40">
            {TYPE_OPTIONS.map(o=>(
              <button key={o.v} type="button" onClick={()=>openWith(o.v)}
                className="w-full flex items-center gap-3 px-5 py-3.5 text-sm font-bold transition border-b border-[#f4f6f9] last:border-0 hover:brightness-95"
                style={{background:o.color+"12"}}>
                <span className="text-2xl w-8 text-center">{TIPO_ICON[o.v]}</span>
                <div className="text-left flex-1">
                  <div className="font-black" style={{color:o.color}}>{o.l}</div>
                  <div className="text-xs text-slate-400 font-normal">{o.desc}</div>
                </div>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${o.pill}`}>{o.desc.split("·")[0].trim()}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Aviso de citas pasadas sin resultado */}
      {sinResultado>0 && (
        <button onClick={()=>{setFiltro("todas");setFiltroTipo("todos");setFiltroResultado("todos");}}
          className="w-full mb-4 p-3 rounded-xl bg-amber-50 border border-amber-300 text-sm text-amber-800 font-bold flex items-center justify-between hover:bg-amber-100 transition">
          <span><Ico e="⏰" className="mr-1.5" />{sinResultado} cita(s) pasada(s) sin resultado</span>
          <span className="text-xs">Ver →</span>
        </button>
      )}

      {/* Cambiar entre vista de lista y calendario */}
      <div className="grid grid-cols-2 gap-1.5 mb-3">
        {[["lista","📋","Lista"],["calendario","📆","Calendario"]].map(([v,ico,l])=>(
          <button key={v} onClick={()=>setVista(v)}
            className={`py-2.5 rounded-xl text-xs font-bold transition ${vista===v?"text-white shadow-sm":"text-slate-600 bg-[#f4f6f9]"}`}
            style={vista===v?{background:RP.navy}:{}}><span className="inline-flex items-center justify-center gap-1.5"><Ico e={ico} size={13} />{l}</span></button>
        ))}
      </div>

      {/* Buscador */}
      <input className={inpLight+" mb-3"} placeholder="Buscar cita por nombre o teléfono…" name="buscar-cita" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} value={busca} onChange={e=>setBusca(e.target.value)} />

      {/* Filtros tipo pestañas (solo vista lista) */}
      {vista==="lista" && <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1">
        {FILTROS.map(f=>(
          <button key={f.id} onClick={()=>setFiltro(f.id)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition ${filtro===f.id?"text-white":"text-slate-600 bg-[#f4f6f9]"}`}
            style={filtro===f.id?{background:RP.blue}:{}}>
            {f.label}
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${filtro===f.id?"bg-white/25":"bg-white"}`}>{f.count}</span>
          </button>
        ))}
      </div>}

      {/* Filtrar por tipo y resultado (colapsable) */}
      <button onClick={()=>setMostrarFiltros(p=>!p)}
        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-bold mb-3 transition ${filtrosActivos>0?"text-white":"text-slate-600 bg-[#f4f6f9]"}`}
        style={filtrosActivos>0?{background:RP.navy}:{}}>
        <span><Ico e="🔎" className="mr-1.5" />Filtrar por tipo y resultado{filtrosActivos>0?` · ${filtrosActivos} activo${filtrosActivos>1?"s":""}`:""}</span>
        <span className="flex items-center gap-2">
          {filtrosActivos>0 && <span onClick={e=>{e.stopPropagation();setFiltroTipo("todos");setFiltroResultado("todos");}} className="text-[10px] bg-white/25 px-2 py-0.5 rounded-full">Limpiar ✕</span>}
          <span className={`transition-transform duration-200 ${mostrarFiltros?"rotate-180":""}`}>▾</span>
        </span>
      </button>
      {mostrarFiltros && (
        <div className="mb-4 space-y-2 bg-[#f9fafc] rounded-xl p-3 border border-[#eef1f5]">
          <div>
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 px-0.5">Tipo</div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {TIPO_FILTROS.map(t=>(
                <button key={t.v} onClick={()=>setFiltroTipo(t.v)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition ${filtroTipo===t.v?"text-white":"text-slate-600 bg-white border border-[#e8edf3]"}`}
                  style={filtroTipo===t.v?{background:RP.blue}:{}}>{t.label}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 px-0.5">Resultado de la cita</div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {RES_FILTROS.map(r=>(
                <button key={r.v} onClick={()=>setFiltroResultado(r.v)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition ${filtroResultado===r.v?"text-white":"text-slate-600 bg-white border border-[#e8edf3]"}`}
                  style={filtroResultado===r.v?{background:RP.blue}:{}}>{r.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Calendario (día / semana / mes / año) */}
      {vista==="calendario" && (
        <CalendarioAgenda appts={base}
          onUpdate={u=>{setAppts(p=>p.map(x=>x.id===u.id?u:x)); if(u.resultado==="demo_venta" && !u._sincronizado && onVentaSync) onVentaSync(u);}}
          onDelete={id=>setAppts(p=>p.filter(x=>x.id!==id))} />
      )}

      {/* Lista de citas */}
      {vista==="lista" && (lista.length===0
        ? <div className="bg-white rounded-2xl p-8 text-center text-sm text-slate-400 shadow-sm border border-[#e8edf3]">
            {busca||filtrosActivos>0?"No hay citas que coincidan con los filtros":filtro==="hoy"?"No hay citas para hoy":filtro==="proximas"?"No hay citas próximas":"No hay citas agendadas"}
          </div>
        : <div className="space-y-2">{lista.map(a=>{
            const esPasada=a.fecha&&a.fecha<ahora&&!a.fecha.startsWith(todayStr);
            return (
              <div key={a.id} className={`bg-white border-2 border-[#e8edf3] border-l-4 rounded-2xl shadow-sm ${TIPO_BORDER[a._type]||"border-l-slate-300"} ${esPasada&&!a.resultado?"ring-1 ring-amber-200":""}`}>
                <CitaCard a={a} mostrarFecha={filtro!=="hoy"} esPasada={esPasada}
                  onUpdate={u=>{setAppts(p=>p.map(x=>x.id===u.id?u:x)); if(u.resultado==="demo_venta" && !u._sincronizado && onVentaSync) onVentaSync(u);}}
                  onDelete={id=>setAppts(p=>p.filter(x=>x.id!==id))} />
              </div>
            );
          })}</div>)}

      {showForm && <Modal title={`${TIPO_ICON[preType]||"📅"} ${TYPE_OPTIONS.find(t=>t.v===preType)?.l||"Nueva cita"}`} onClose={()=>{setShowForm(false);setPreType(null);}}>
        <AppointmentForm forceTipo={preType} loading={calLoading} onSave={handleSchedule} onClose={()=>{setShowForm(false);setPreType(null);}} agenteActivo={agente} />
      </Modal>}
    </div>
  );
}

// ─── CALL CONTROL ─────────────────────────────────────────────
// Aplana los referidos individuales como contactos llamables.
// Cada uno lleva _refDe (id anfitrión) y _refIdx (posición) para guardar de vuelta.
function flattenReferidos(referidosArr) {
  const out=[];
  (referidosArr||[]).forEach(anf=>{
    // D) Si el anfitrión NO tiene id válido, NO generamos sus referidos llamables
    // (evita ids rotos tipo "undefined::0" que luego no se pueden abrir).
    const anfId = anf?.id;
    if(anfId===undefined || anfId===null || anfId==="") return;
    (anf.referidos||[]).forEach((r,idx)=>{
      out.push({
        ...r,
        id: `${anfId}::${idx}`,
        _tipo: "referidos",
        _refDe: anfId,
        _refIdx: idx,
        _anfitrion: anf.anfitrion||"",
        _parentesco: r.parentesco||"",
        nombre: r.nombre || "(Referido sin nombre)",
        observaciones: r.observaciones || (anf.anfitrion?`Referido de ${anf.anfitrion}`:""),
      });
    });
  });
  return out;
}

function CallControl({ data, setData, onCallLog, role, agente, notify, setAppts }) {
  const [scheduleClient,setScheduleClient]=useState(null);const [forceTipo,setForceTipo]=useState(null);const [calLoading,setCalLoading]=useState(false);const [calMsg,setCalMsg]=useState("");
  const [filterCity,setFilterCity]=useState("");const [filterCP,setFilterCP]=useState("");const [search,setSearch]=useState("");const [filterBase,setFilterBase]=useState("todas");

  const referidosLlamables = flattenReferidos(data.referidos)
    .filter(c=>(c.nombre&&c.nombre!=="(Referido sin nombre)")||c.telefono)  // solo referidos con datos reales
    .filter(c=>["sin_estado","naranja","amarillo","azul","morado","buzon","verde","numero_equivocado"].includes(c.estado||"sin_estado"));
  const pendientesAll=[
    ...data.prospectos.filter(c=>!c.eliminado && ["sin_estado","naranja","amarillo","azul","morado","buzon","numero_equivocado"].includes(c.estado)).map(c=>({...c,_tipo:"prospectos"})),
    ...data.agregados.filter(c=>!c.eliminado && ["sin_estado","naranja","buzon","verde","numero_equivocado"].includes(c.estado)).map(c=>({...c,_tipo:"agregados"})),
    ...data.distribucion.filter(c=>!c.eliminado && ["sin_estado","naranja","buzon","verde","numero_equivocado"].includes(c.estado)).map(c=>({...c,_tipo:"distribucion"})),
    ...referidosLlamables,
  ];
  const norm=(t)=>(t||"").toString().trim().toLowerCase();
  // ── FILTRO ÚNICO de ciudad + CP, reutilizado por TODAS las vistas (pendientes, estados, prioridad, zonas) ──
  // Ciudad: parcial sin acentos. CP: EXACTO con 5 dígitos (menos de 5 no filtra).
  const coincideFiltro=(c)=>coincideBusqueda(c, {search, filterCity, filterCP});
  const zipQuery = normalizeZip(filterCP);
  const zipIncompleto = zipQuery.length>0 && zipQuery.length<5; // 1-4 dígitos → avisar
  const cpFiltraActivo = zipQuery.length===5;                    // 5 dígitos → sí filtra
  const hayFiltro = !!(filterCity || cpFiltraActivo);            // CP solo cuenta como filtro con 5 díg
  // Ciudades disponibles (de TODOS los clientes activos, no solo pendientes)
  const cities=[...new Set([...data.agregados,...data.prospectos,...data.distribucion].filter(c=>!c.eliminado).map(c=>(c.ciudad||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"es"));
  // Pendientes filtrados + ORDENADOS por última vez llamado (rotación sin repetir)
  // displayedClients = ÚNICA fuente de verdad para pendientes:
  // 1) filtra por estado (pendientesAll), 2) filtra por ciudad/CP (coincideFiltro),
  // 3) descarta cualquier registro sin id válido (requisito 7), 4) ordena por rotación.
  const tieneIdValido=(c)=>{
    if(!c) return false;
    // C) Referidos: id debe tener formato "anfitrionId::indice" con anfitrionId no vacío
    if(c._tipo==="referidos"){
      if(typeof c.id!=="string") return false;
      const partes=c.id.split("::");
      const anfId=partes[0];
      const idx=partes[1];
      return !!anfId && anfId!=="undefined" && anfId!=="null" && idx!==undefined && idx!=="";
    }
    // Clientes normales: el id debe existir
    return c?.id!==undefined && c?.id!==null && c?.id!=="";
  };
  const coincideBase=(c)=>filterBase==="todas" || c._tipo===filterBase;
  const pendientes=pendientesAll
    .filter(coincideFiltro)
    .filter(coincideBase)
    .filter(tieneIdValido)
    .sort((a,b)=>{
      // Rotación ÚNICA para TODAS las bases por igual (referidos incluidos, sin
      // privilegio): primero los NUNCA llamados, y los YA llamados bajan por fecha
      // (más reciente al final). Así "marcar como llamado" manda al cliente al
      // final de verdad, sea agregado, distribución, prospecto o referido.
      const ta=a.ultimo_llamado||"";  // "" = nunca llamado
      const tb=b.ultimo_llamado||"";
      // Ambos sin llamar: lo MÁS NUEVO primero — cualquier dato recién subido
      // (importado, agregado a mano o referido nuevo) aparece arriba de la lista.
      if(!ta && !tb) return String(b.creado||"").localeCompare(String(a.creado||""));
      if(!ta) return -1;              // sin llamar va antes que llamado
      if(!tb) return 1;
      return ta.localeCompare(tb);    // ambos llamados: más antiguo primero, recién llamado al final
    });

  // ── TODOS los clientes (activos) con su tipo, para agrupar por estado — TAMBIÉN se filtra por ciudad/CP ──
  // Filtra por ciudad/CP Y descarta registros sin id válido (requisito 7).
  const todosClientes=[
    ...data.agregados.filter(c=>!c.eliminado).map(c=>({...c,_tipo:"agregados"})),
    ...data.prospectos.filter(c=>!c.eliminado).map(c=>({...c,_tipo:"prospectos"})),
    ...data.distribucion.filter(c=>!c.eliminado).map(c=>({...c,_tipo:"distribucion"})),
    ...referidosLlamables,
  ].filter(coincideFiltro).filter(coincideBase).filter(tieneIdValido);
  // Orden de las secciones por estado (usa los estados REALES de la app)
  const ORDEN_ESTADOS=["verde","azul","amarillo","morado","naranja","buzon","rojo","magenta","numero_equivocado","sin_estado"];
  // Un cliente solo va a UNA sección (la de su estado actual)
  const clientesPorEstado={};
  ORDEN_ESTADOS.forEach(e=>clientesPorEstado[e]=[]);
  todosClientes.forEach(c=>{
    const e=clientesPorEstado[c.estado]!==undefined?c.estado:"sin_estado";
    clientesPorEstado[e].push(c);
  });

  // ── 🔥 PRIORIDAD HOY + ⚠️ SEGUIMIENTOS VENCIDOS ──
  const hoyISO=hoyLocal();
  const citasHoyFechas=new Set((data.appts||[]).filter(a=>(a.fecha||"").slice(0,10)===hoyISO).map(a=>(a.nombre||"").toLowerCase().trim()));
  const diasVencido=(fecha)=>{
    if(!fecha) return 0;
    const f=new Date(fecha+"T00:00:00"); const h=new Date(hoyISO+"T00:00:00");
    return Math.round((h-f)/(1000*60*60*24));
  };
  // Marca cada cliente con su motivo de prioridad
  const prioridadHoy=[]; const vencidos=[];
  todosClientes.forEach(c=>{
    const motivos=[];
    // Cita programada hoy (estado verde + seguimiento hoy, o aparece en appts de hoy)
    if(c.proximo_seguimiento===hoyISO) motivos.push("Seguimiento hoy");
    if(c.estado==="verde" && (citasHoyFechas.has((c.nombre||"").toLowerCase().trim()))) motivos.push("Cita hoy");
    // Seguimiento vencido
    const dvReal=c.proximo_seguimiento && c.proximo_seguimiento<hoyISO ? diasVencido(c.proximo_seguimiento) : 0;
    // Un recordatorio vencido solo vive 2 días en prioridad; después sale solo.
    const dv = dvReal>0 && dvReal<=2 ? dvReal : 0;
    if(dv>0){ motivos.push(`Vencido hace ${dv} día${dv!==1?"s":""}`); vencidos.push({...c,_diasVencido:dv}); }
    if(motivos.length>0 && !(motivos.length===1 && dv>0)){
      // Va a Prioridad Hoy si tiene algo de HOY (no solo vencido)
      prioridadHoy.push({...c,_motivos:motivos,_diasVencido:dv});
    } else if(dv>0){
      // Solo vencido → también entra a prioridad pero marcado distinto
      prioridadHoy.push({...c,_motivos:motivos,_diasVencido:dv});
    }
  });
  vencidos.sort((a,b)=>b._diasVencido-a._diasVencido);

  // Actualiza un referido dentro de su anfitrión y revisa si toca obsequio
  const updateReferido=(refDe,refIdx,patch)=>{
    setData("referidos", p=>p.map(anf=>{
      if(anf.id!==refDe) return anf;
      const refs=[...(anf.referidos||[])];
      refs[refIdx]={...refs[refIdx],...patch};
      // Contar citas (verde) y ventas de los referidos de este anfitrión
      const citas=refs.filter(r=>r.estado==="verde").length;
      const ventas=refs.filter(r=>r.venta||r.resultado==="venta").length;
      // Disparar alerta de obsequio una sola vez
      if(!anf._obsequioAvisado && (citas>=4 || ventas>=1) && notify){
        const motivo = ventas>=1 ? `1 venta de sus referidos` : `${citas} citas coordinadas`;
        notify("obsequio",
          `🎁 ¡Obsequio para ${anf.anfitrion||"anfitrión"}!`,
          `${anf.anfitrion||"Un anfitrión"} logró ${motivo}. Hay que pedir su regalo${anf.regalo?`: ${anf.regalo}`:""}.`,
          "🎁 Referidos"
        );
        return {...anf, referidos:refs, _obsequioAvisado:true};
      }
      return {...anf, referidos:refs};
    }));
  };

  const updateStatus=(id,tipo,status)=>{
    if(tipo==="referidos"){
      const [refDe,refIdx]=id.split("::");
      updateReferido(refDe, +refIdx, {estado:status, proximo_seguimiento:""});
    } else {
      // Al cambiar el estado, el recordatorio/seguimiento se limpia → el cliente
      // SALE de la lista de prioridad automáticamente.
      setData(tipo,p=>p.map(x=>x.id===id?{...x,estado:status, proximo_seguimiento:""}:x));
    }
  };
  const saveHistorial=(id,tipo,entry)=>{
    if(tipo==="referidos"){
      const [refDe,refIdx]=id.split("::");
      setData("referidos", p=>p.map(anf=>{
        if(anf.id!==refDe) return anf;
        const refs=[...(anf.referidos||[])];
        refs[refIdx]={...refs[refIdx], historial:[...(refs[refIdx].historial||[]), entry]};
        return {...anf, referidos:refs};
      }));
    } else {
      setData(tipo,p=>addHistorialEntry(p,id,entry));
    }
  };
  // Marca un cliente como "llamado ahora" → se va al final de la lista de pendientes
  const marcarLlamado=(id,tipo)=>{
    const ahora=new Date().toISOString();
    if(tipo==="referidos"){
      const [refDe,refIdx]=id.split("::");
      setData("referidos", p=>p.map(anf=>{
        if(anf.id!==refDe) return anf;
        const refs=[...(anf.referidos||[])];
        refs[refIdx]={...refs[refIdx], ultimo_llamado:ahora};
        return {...anf, referidos:refs};
      }));
    } else {
      setData(tipo,p=>p.map(x=>x.id===id?{...x,ultimo_llamado:ahora}:x));
    }
  };
  const saveNota=(id,tipo,texto)=>{
    if(tipo==="referidos"){
      const [refDe,refIdx]=id.split("::");
      setData("referidos", p=>p.map(anf=>{
        if(anf.id!==refDe) return anf;
        const refs=[...(anf.referidos||[])];
        refs[refIdx]=agregarNota(refs[refIdx], texto, agente);
        return {...anf, referidos:refs};
      }));
    } else {
      setData(tipo,p=>p.map(x=>x.id===id?agregarNota(x,texto,agente):x));
    }
  };
  // Eliminar una entrada del historial (llamada/cita) desde el área de Llamadas
  const deleteHist=(id,tipo,entryKey)=>{
    if(tipo==="referidos"){
      const [refDe,refIdx]=id.split("::");
      setData("referidos", p=>p.map(anf=>{
        if(anf.id!==refDe) return anf;
        const refs=[...(anf.referidos||[])];
        refs[refIdx]={...refs[refIdx], historial:(refs[refIdx].historial||[]).filter(h=>(h.id||h.fecha)!==entryKey)};
        return {...anf, referidos:refs};
      }));
    } else {
      setData(tipo,p=>deleteHistorialEntry(p,id,entryKey));
    }
  };
  // ── Eliminar y editar clientes desde el área de Llamadas (funciona en todas las vistas) ──
  const [editCall,setEditCall]=useState(null); // {cliente, tipo}
  const eliminarCliente=(id,tipo)=>{
    if(tipo==="referidos"){ alert("Los referidos se eliminan desde la pestaña Referidos."); return; }
    if(!confirm("¿Mover este registro a la papelera? Podrás restaurarlo desde su pestaña.")) return;
    setData(tipo,p=>p.map(x=>x.id===id?{...x,eliminado:true}:x));
  };
  const editarCliente=(cliente,tipo)=>{
    if(tipo==="referidos"){ alert("Los referidos se editan desde la pestaña Referidos."); return; }
    setEditCall({cliente,tipo});
  };
  const guardarEdicionCall=(d)=>{
    if(!editCall) return;
    setData(editCall.tipo, p=>p.map(x=>x.id===editCall.cliente.id?{...d,id:editCall.cliente.id}:x));
    setEditCall(null);
  };
  const openSchedule=(client,tipo=null)=>{setScheduleClient(client);setForceTipo(tipo);};
  const handleSchedule=appt=>{
    window.open(gcalLink(appt),"_blank");
    if(setAppts) setAppts(p=>[{...appt,id:genId(),_type:appt.tipo},...p]);

    // Guardar info de la cita en la tarjeta del cliente (igual que DBSection)
    if(scheduleClient){
      const sc=scheduleClient;
      const tipo=sc._tipo;
      const actualizarCliente=(clientes)=>clientes.map(x=>{
        if(x.id!==sc.id) return x;
        const upd={...x};
        if(!upd.telefono && appt.telefono) upd.telefono=appt.telefono;
        if(!upd.direccion && appt.direccion) upd.direccion=appt.direccion;
        if(!upd.ciudad && appt.ciudad) upd.ciudad=appt.ciudad;
        if(!upd.cp && appt.cp) upd.cp=appt.cp;
        if(!upd.cuenta && appt.cuenta) upd.cuenta=appt.cuenta;
        if(appt.notas && appt.notas.trim()){
          const notaCita=`[Cita ${appt.tipo||"cita"} ${(appt.fecha||"").slice(0,10)}] ${appt.notas.trim()}`;
          upd.ultimaNota=notaCita;
          upd.notas=[...(upd.notas||[]),{texto:notaCita,fecha:new Date().toISOString(),agente:appt.agente||agente}];
        }
        if(["llamada","seguimiento","reset"].includes(appt.tipo) && appt.fecha)
          upd.proximo_seguimiento=(appt.fecha||"").slice(0,10);
        upd.ultima_cita_programada=(appt.fecha||"").slice(0,16);
        upd.actualizado=new Date().toISOString();
        return upd;
      });
      if(tipo==="referidos"){
        const [refDe,refIdx]=sc.id.split("::");
        setData("referidos",p=>p.map(anf=>{
          if(anf.id!==refDe) return anf;
          const refs=[...(anf.referidos||[])];
          refs[+refIdx]=actualizarCliente([refs[+refIdx]])[0];
          return {...anf,referidos:refs};
        }));
      } else if(tipo){
        setData(tipo,actualizarCliente);
      }
    }

    setCalMsg(`✅ ${appt.nombre} — cita guardada en Agenda y se abrió Google Calendar: solo toca GUARDAR allá.`);
    setScheduleClient(null); setForceTipo(null);
  };
  const handleApptResult=(c,id,detail="",monto="",producto="",cartucho_meses=0)=>{
    const t=c._tipo;
    const montoNum = id==="demo_venta" ? Number(monto)||0 : 0;
    const patch = id==="demo_venta" ? {venta:true,resultado:"demo_venta",resultado_detalle:detail,ultimo_monto_venta:montoNum||undefined,ultimo_producto:producto||undefined,ultimo_cartucho_meses:cartucho_meses||undefined}
                : id==="demo_no_venta" ? {venta:false,resultado:"demo_no_venta",resultado_detalle:detail}
                : id==="no_recibio" ? {venta:false,resultado:"no_recibio",resultado_detalle:detail}
                : id==="no_visito" ? {venta:false,resultado:"no_visito",resultado_detalle:detail}
                : id==="seguimiento" ? {resultado:"seguimiento",resultado_detalle:detail}
                : id==="reset" ? {resultado:"reset",resultado_detalle:detail} : {};
    if(t==="referidos"){
      const [refDe,refIdx]=c.id.split("::");
      updateReferido(refDe, +refIdx, patch);
    } else {
      setData(t,p=>p.map(x=>x.id===c.id?{...x,...patch}:x));
    }
    if(id==="seguimiento") openSchedule(c,"llamada");
    if(id==="reset") openSchedule(c,"reset");
  };

  // ── LLAMADAS REALIZADAS HOY ──
  // Recolecta de TODOS los datos las entradas de historial tipo "llamada" hechas hoy.
  const [subTab,setSubTab]=useState("pendientes");  // pendientes | estados | hoy | total
  const [estadosAbiertos,setEstadosAbiertos]=useState({verde:true}); // secciones de "por estado" colapsables
  const [zonasAbiertas,setZonasAbiertas]=useState({}); // secciones de "zonas" colapsables
  const [zonaVer,setZonaVer]=useState({}); // cuántas tarjetas mostrar por zona (paginado ligero)
  const [zonaModo,setZonaModo]=useState("ciudad"); // ciudad | zip
  const hoyStr=hoyLocal();
  const SRC_LABEL={agregados:"📂 Agregados",prospectos:"🔍 Prospección",distribucion:"🏠 Distribución",referidos:"🎁 Referido"};

  const recolectarLlamadas=(soloHoy)=>{
    const out=[];
    const push=(nombre,fuente,h,anfitrion)=>{
      // Cuenta llamadas Y cambios de estado (ambos significan que hubo contacto)
      if(h.tipo!=="llamada" && h.tipo!=="estado") return;
      if(soloHoy && diaLocal(h.fecha)!==hoyStr) return;
      out.push({nombre, fuente, anfitrion, estado:h.estado, notas:h.notas, fecha:h.fecha, agente:h.agente, tipo:h.tipo});
    };
    (data.agregados||[]).forEach(c=>(c.historial||[]).forEach(h=>push(c.nombre,"agregados",h)));
    (data.prospectos||[]).forEach(c=>(c.historial||[]).forEach(h=>push(c.nombre,"prospectos",h)));
    (data.distribucion||[]).forEach(c=>(c.historial||[]).forEach(h=>push(c.nombre,"distribucion",h)));
    (data.referidos||[]).forEach(anf=>(anf.referidos||[]).forEach(r=>(r.historial||[]).forEach(h=>push(r.nombre,"referidos",h,anf.anfitrion))));
    // Más recientes primero
    return out.sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||""));
  };
  const llamadasHoy=recolectarLlamadas(true);
  const llamadasTotal=recolectarLlamadas(false);

  const LlamadaItem=({l})=>{
    const est=STATUS_COLORS[l.estado];
    const d=l.fecha?new Date(l.fecha):null;
    const hora=d?d.toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"}):"";
    const fecha=d?d.toLocaleDateString("es-MX",{day:"numeric",month:"short"}):"";
    const SRC_MINI={agregados:{t:"AGG",bg:"#f1ecfd",c:"#5b21b6"},prospectos:{t:"PROS",bg:"#fef3e2",c:"#b45309"},distribucion:{t:"DIS",bg:"#e7f6ec",c:"#047857"},referidos:{t:"REF",bg:"#faf5ff",c:"#7c3aed"}};
    const sc=SRC_MINI[l.fuente];
    return (
      <div className="bg-white rounded-xl border border-[#e8edf3] p-3 flex items-start gap-2.5">
        <div className="w-8 h-8 rounded-full bg-[#e8edf3] flex items-center justify-center text-base shrink-0 mt-0.5"><Ico e="📞" /></div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-1">
            {sc && <span className="text-[9px] font-black px-1.5 py-0.5 rounded shrink-0" style={{background:sc.bg,color:sc.c}}>{sc.t}</span>}
            <span className="font-bold text-sm text-[#1f2d3d] truncate">{l.nombre||"(Sin nombre)"}</span>
            {l.fuente==="referidos" && l.anfitrion && <span className="text-[10px] text-purple-500">ref. de {l.anfitrion}</span>}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {est && <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md" style={est.style}>{est.label}</span>}
            <span className="text-[10px] text-slate-400 bg-[#f4f6f9] px-1.5 py-0.5 rounded-md"><Ico e="🕐" className="mr-1.5" />{hora}</span>
            <span className="text-[10px] text-slate-400 bg-[#f4f6f9] px-1.5 py-0.5 rounded-md"><Ico e="📅" className="mr-1.5" />{fecha}</span>
            {l.agente && <span className="text-[10px] text-[#5b21b6] bg-[#5b21b6]/8 px-1.5 py-0.5 rounded-md font-bold"><Ico e="👤" className="mr-1.5" />{l.agente}</span>}
          </div>
          {l.notas && <div className="text-[11px] text-slate-500 italic bg-[#f4f6f9] rounded-lg px-2 py-1 mt-1.5">📝 "{l.notas}"</div>}
        </div>
      </div>
    );
  };

  return (
    <div>
      {calMsg && <div className="mb-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-700 font-bold flex items-center justify-between"><Msg>{calMsg}</Msg><button onClick={()=>setCalMsg("")} className="ml-2"><Ico e="✕" /></button></div>}

      {/* Sub-pestañas */}
      <div className="flex gap-1.5 mb-4">
        {[
          {id:"prioridad",ico:"🔥", label:"Prioridad",n:prioridadHoy.length},
          {id:"pendientes",ico:"⏳", label:"Pendientes",n:pendientesAll.length},
          {id:"estados",ico:"🗂", label:"Estados",n:todosClientes.length},
          {id:"zonas",ico:"📍", label:"Zonas",n:Object.keys(todosClientes.reduce((a,c)=>{if(c.ciudad)a[normTexto(limpiaCiudad(c.ciudad))]=1;return a;},{})).length},
          {id:"hoy",ico:"✅", label:"Hoy",n:llamadasHoy.length},
          {id:"total",ico:"📊", label:"Total",n:llamadasTotal.length},
        ].map(t=>(
          <button key={t.id} onClick={()=>setSubTab(t.id)}
            className={`flex-1 px-1 py-2.5 rounded-xl text-[10px] font-bold transition flex flex-col items-center gap-0.5 ${subTab===t.id?"text-white":"text-slate-600 bg-[#f4f6f9]"}`}
            style={subTab===t.id?{background:RP.navy}:{}}>
            <span>{t.label}</span>
            <span className={`text-base font-black ${subTab===t.id?"text-white":"text-[#5b21b6]"}`} style={{fontFamily:SERIF}}>{t.n}</span>
          </button>
        ))}
      </div>

      {/* ── FILTRO de ciudad + CP — visible en todas las vistas excepto Hoy/Total (que son de llamadas) ── */}
      {["prioridad","pendientes","estados","zonas"].includes(subTab) && (
        <>
          <input className="w-full border-2 border-[#e5def4] rounded-lg px-3 py-2.5 text-sm bg-white focus:outline-none focus:border-[#7c3aed] mb-2" placeholder="Buscar por nombre o teléfono…" name="buscar-llamadas" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} value={search} onChange={e=>setSearch(e.target.value)} />
          {/* ── FILTRO POR BASE ── */}
          <div className="flex gap-1.5 mb-2 overflow-x-auto pb-1">
            {[["todas","📋","Todas"],["agregados","➕","Agregados"],["distribucion","🚚","Distribución"],["referidos","🔗","Referidos"],["prospectos","🎯","Prospección"]].map(([id,ico,label])=>(
              <button key={id} onClick={()=>setFilterBase(id)}
                className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-black transition ${filterBase===id?"text-white":"bg-white text-slate-500 border border-[#e5def4]"}`}
                style={filterBase===id?{background:RP.navy}:{}}><Ico e={ico} size={12} />{label}</button>
            ))}
          </div>
          <div className="flex gap-2 mb-3">
            <div className="flex-1 relative">
              <input list="ciudades-llamadas" className="w-full border-2 border-[#e5def4] rounded-lg px-2 py-2 text-xs bg-white font-bold text-slate-700 focus:outline-none focus:border-[#7c3aed]"
                placeholder={`Filtrar ciudad (${cities.length} disponibles)`}
                name="filtro-ciudad-llamadas" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                value={filterCity} onChange={e=>setFilterCity(e.target.value)} />
              <datalist id="ciudades-llamadas">
                {cities.map(c=><option key={c} value={c}>{c}</option>)}
              </datalist>
            </div>
            <input className="border-2 border-[#e5def4] rounded-lg px-2 py-2 text-xs bg-white font-bold text-slate-700 w-24"
              placeholder="C.P. (5 díg)" inputMode="numeric" maxLength={10}
              name="filtro-cp-llamadas" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              value={filterCP} onChange={e=>setFilterCP(e.target.value)} />
            {(filterCity||filterCP) && <button onClick={()=>{setFilterCity("");setFilterCP("");}} className="text-xs text-red-400 font-bold px-1 hover:text-red-600"><Ico e="✕" /></button>}
          </div>
          {zipIncompleto && <div className="mb-3 text-xs font-bold text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"><Ico e="📮" className="mr-1.5" />Escribe 5 dígitos para filtrar por código postal</div>}
          {hayFiltro && <div className="mb-3 text-xs font-bold text-[#5b21b6]"><Ico e="🔎" className="mr-1.5" />Filtro activo{filterCity?` · ciudad "${filterCity}"`:""}{cpFiltraActivo?` · CP "${zipQuery}"`:""}</div>}
        </>
      )}

      {/* ── PRIORIDAD HOY ── */}
      {subTab==="prioridad" && (
        <div className="space-y-3">
          <div className="text-xs text-slate-400">Clientes con algo importante para hoy o seguimientos vencidos. Aquí empiezas el día.</div>

          {/* Seguimientos vencidos primero (lo más urgente) */}
          {vencidos.length>0 && (
            <div className="rounded-2xl border-2 border-red-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-red-50 flex items-center justify-between">
                <span className="text-sm font-black text-red-700"><Ico e="⚠" className="mr-1.5" />Seguimientos vencidos</span>
                <span className="text-xs font-black text-white bg-red-500 px-2 py-0.5 rounded-full">{vencidos.length}</span>
              </div>
              <div className="p-2 space-y-2 bg-[#fff8f8]">
                {vencidos.map((c,_i)=>(
                  <div key={`venc-${_i}-${c._tipo}-${String(c.id)}`} className="relative">
                    <div className="absolute -top-1 -right-1 z-10 text-[9px] font-black text-white bg-red-500 px-1.5 py-0.5 rounded-full shadow"><Ico e="🔴" className="mr-1.5" />{c._diasVencido}d</div>
                    <ClientRow c={c} type={c._tipo==="referidos"?"referido-llamada":c._tipo} role={role}
                      onStatusChange={(id,status)=>updateStatus(id,c._tipo,status)} onEdit={cc=>editarCliente(cc,c._tipo)} onSchedule={cc=>openSchedule(cc)} onDelete={id=>eliminarCliente(id,c._tipo)}
                      onCall={onCallLog} onApptResult={handleApptResult} onSaveCallToHistorial={(id,entry)=>saveHistorial(id,c._tipo,entry)} onSaveNota={(id,texto)=>saveNota(id,c._tipo,texto)} agente={agente} onDeleteHistorial={(cid,ekey)=>deleteHist(cid,c._tipo,ekey)} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Prioridad de hoy (citas/seguimientos de hoy) */}
          {(()=>{
            const soloHoy=prioridadHoy.filter(c=>c._motivos.some(m=>m.includes("hoy")||m.includes("Cita")||m.includes("Seguimiento hoy")));
            if(soloHoy.length===0 && vencidos.length===0){
              return (
                <div className="bg-white rounded-2xl p-8 text-center shadow-sm border border-[#e8edf3]">
                  <div className="mb-2 flex justify-center"><Ico e="🎉" size={36} strokeWidth={1.25} className="opacity-40" /></div>
                  <div className="text-sm text-slate-400">Nada urgente para hoy. ¡Vas al día!</div>
                </div>
              );
            }
            if(soloHoy.length===0) return null;
            return (
              <div className="rounded-2xl border-2 border-[#16a34a]/30 overflow-hidden">
                <div className="px-4 py-2.5 bg-emerald-50 flex items-center justify-between">
                  <span className="text-sm font-black text-emerald-700"><Ico e="🔥" className="mr-1.5" />Para hoy</span>
                  <span className="text-xs font-black text-white bg-emerald-500 px-2 py-0.5 rounded-full">{soloHoy.length}</span>
                </div>
                <div className="p-2 space-y-2 bg-[#f8fdf9]">
                  {soloHoy.map((c,_i)=>(
                    <div key={`hoy-${_i}-${c._tipo}-${String(c.id)}`}>
                      <div className="flex flex-wrap gap-1 mb-1">
                        {c._motivos.map((m,i)=>(
                          <span key={i} className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${m.includes("Vencido")?"bg-red-100 text-red-600":m.includes("Cita")?"bg-green-100 text-green-700":"bg-amber-100 text-amber-700"}`}>{m.includes("Cita")?<><Ico e="📅" className="mr-1" /></>:m.includes("Seguimiento")?<><Ico e="⏰" className="mr-1" /></>:<><Ico e="⚠" className="mr-1" /></>}{m}</span>
                        ))}
                      </div>
                      <ClientRow c={c} type={c._tipo==="referidos"?"referido-llamada":c._tipo} role={role}
                        onStatusChange={(id,status)=>updateStatus(id,c._tipo,status)} onEdit={cc=>editarCliente(cc,c._tipo)} onSchedule={cc=>openSchedule(cc)} onDelete={id=>eliminarCliente(id,c._tipo)}
                        onCall={onCallLog} onApptResult={handleApptResult} onSaveCallToHistorial={(id,entry)=>saveHistorial(id,c._tipo,entry)} onSaveNota={(id,texto)=>saveNota(id,c._tipo,texto)} agente={agente} onDeleteHistorial={(cid,ekey)=>deleteHist(cid,c._tipo,ekey)} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── POR ESTADO: secciones colapsables ── */}
      {subTab==="estados" && (
        <div className="space-y-2">
          <div className="text-xs text-slate-400 mb-1">Cada cliente aparece en la sección de su estado actual. Cambia el estado de un cliente y se mueve solo.</div>
          {ORDEN_ESTADOS.filter(e=>clientesPorEstado[e].length>0).map(e=>{
            const info=STATUS_COLORS[e];
            const lista=clientesPorEstado[e];
            const abierto=estadosAbiertos[e];
            return (
              <div key={e} className="rounded-xl border border-[#e8edf3] overflow-hidden">
                <button onClick={()=>setEstadosAbiertos(p=>({...p,[e]:!p[e]}))}
                  className="w-full flex items-center justify-between px-3 py-2.5 transition" style={info.style}>
                  <span className="flex items-center gap-2 font-bold text-sm">
                    <span className="w-2.5 h-2.5 rounded-full" style={{background:info.style.color==="#1f2d3d"?"#1f2d3d":"rgba(255,255,255,0.85)"}} />
                    {info.label}
                    <span className="text-xs font-black px-2 py-0.5 rounded-full" style={{background:"rgba(255,255,255,0.25)"}}>{lista.length}</span>
                  </span>
                  <span className={`transition-transform duration-200 ${abierto?"rotate-180":""}`}>▾</span>
                </button>
                {abierto && (
                  <div className="p-2 space-y-2 bg-[#f9fafb]">
                    {lista.map((c,_i)=>(
                      <ClientRow key={`est-${e}-${_i}-${c._tipo}-${String(c.id)}`} c={c} type={c._tipo==="referidos"?"referido-llamada":c._tipo} role={role}
                        onStatusChange={(id,status)=>updateStatus(id,c._tipo,status)}
                        onEdit={cc=>editarCliente(cc,c._tipo)} onSchedule={cc=>openSchedule(cc)} onDelete={id=>eliminarCliente(id,c._tipo)}
                        onCall={onCallLog} onApptResult={handleApptResult}
                        onSaveCallToHistorial={(id,entry)=>saveHistorial(id,c._tipo,entry)}
                        onSaveNota={(id,texto)=>saveNota(id,c._tipo,texto)}
                        agente={agente} onDeleteHistorial={(cid,ekey)=>deleteHist(cid,c._tipo,ekey)} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {todosClientes.length===0 && (
            <div className="bg-white rounded-2xl p-8 text-center shadow-sm border border-[#e8edf3]">
              <div className="mb-2 flex justify-center"><Ico e="🗂" size={36} strokeWidth={1.25} className="opacity-40" /></div>
              <div className="text-sm text-slate-400">Aún no hay clientes. Agrégalos o impórtalos con IA.</div>
            </div>
          )}
        </div>
      )}

      {/* ── 📍 ZONAS (segmentación por ciudad/ZIP) ── */}
      {subTab==="zonas" && (()=>{
        const campo = zonaModo==="ciudad" ? "ciudad" : "cp";
        // Agrupación NORMALIZADA: "Dallas", "dallas" y "DALLAS" caen en el mismo grupo
        // (sin acentos, sin mayúsculas/minúsculas, sin espacios dobles).
        const grupos={};
        const variantes={}; // clave normalizada -> conteo de cada forma escrita original
        todosClientes.forEach(c=>{
          const crudo=(c[campo]||"").toString().trim();
          const base=zonaModo==="ciudad"?limpiaCiudad(crudo):crudo; // quita ", Texas", " TX", etc.
          const k=base?normTexto(base):"(sin dato)";
          if(!grupos[k]){ grupos[k]=[]; variantes[k]={}; }
          grupos[k].push(c);
          if(base){ const v=base.replace(/\s+/g," "); variantes[k][v]=(variantes[k][v]||0)+1; }
        });
        // Etiqueta visible: la forma más usada, en Formato Título (ej. "Fort Worth")
        const etiquetaDe=(k)=>{
          if(k==="(sin dato)") return "(sin dato)";
          const vs=Object.entries(variantes[k]||{});
          if(!vs.length) return k;
          const top=vs.sort((a,b)=>b[1]-a[1])[0][0];
          return top.toLowerCase().split(" ").map(w=>w?w[0].toUpperCase()+w.slice(1):w).join(" ");
        };
        const ordenados=Object.entries(grupos).sort((a,b)=>b[1].length-a[1].length);
        return (
          <div className="space-y-2">
            <div className="flex gap-1.5 mb-2">
              {[["ciudad","🏙️ Por ciudad"],["zip","📮 Por código postal"]].map(([v,l])=>(
                <button key={v} onClick={()=>setZonaModo(v)} className={`flex-1 px-3 py-2 rounded-xl text-xs font-bold border-2 transition ${zonaModo===v?"border-[#5b21b6] bg-[#5b21b6]/5 text-[#5b21b6]":"border-[#e5def4] text-slate-500"}`}>{l}</button>
              ))}
            </div>
            <div className="text-xs text-slate-400 mb-1">Clientes y referidos agrupados por {zonaModo==="ciudad"?"ciudad":"código postal"}. Toca una zona para ver y crear ruta.</div>
            {ordenados.map(([zona,lista])=>{
              const abierta=zonasAbiertas[zona];
              const conDir=lista.filter(c=>dirSuficiente(c)).length;
              return (
                <div key={zona} className="rounded-xl border border-[#e8edf3] overflow-hidden">
                  <button onClick={()=>setZonasAbiertas(p=>({...p,[zona]:!p[zona]}))} className="w-full flex items-center justify-between px-3 py-2.5 bg-[#f4f6f9] hover:bg-[#f1ecfd] transition">
                    <span className="flex items-center gap-2 font-bold text-sm text-[#5b21b6]">
                      <span>{zonaModo==="ciudad"?"🏙️":"📮"} {etiquetaDe(zona)}</span>
                      <span className="text-xs font-black px-2 py-0.5 rounded-full bg-[#5b21b6] text-white">{lista.length}</span>
                      {conDir>0 && <span className="text-[10px] text-emerald-600 font-bold"><Ico e="📍" className="mr-1.5" />{conDir} con dirección</span>}
                    </span>
                    <span className={`transition-transform duration-200 ${abierta?"rotate-180":""}`}>▾</span>
                  </button>
                  {abierta && (
                    <div className="p-2 bg-white">
                      <div className="space-y-3 mb-2">
                        {lista.slice(0, zonaVer[zona]||15).map((c,_i)=>(
                          <ClientRow key={`zona-${zona}-${_i}-${c._tipo}-${String(c.id)}`} c={c} type={c._tipo==="referidos"?"referido-llamada":c._tipo} role={role}
                            onStatusChange={(id,status)=>updateStatus(id,c._tipo,status)} onEdit={cc=>editarCliente(cc,c._tipo)} onSchedule={c=>openSchedule(c)}
                            onDelete={id=>eliminarCliente(id,c._tipo)} onCall={onCallLog} onApptResult={handleApptResult}
                            onSaveCallToHistorial={(id,entry)=>saveHistorial(id,c._tipo,entry)} onSaveNota={(id,texto)=>saveNota(id,c._tipo,texto)}
                            agente={agente} onDeleteHistorial={(cid,ekey)=>deleteHist(cid,c._tipo,ekey)} onMarcarLlamado={(id)=>marcarLlamado(id,c._tipo)} />
                        ))}
                      </div>
                      {lista.length>(zonaVer[zona]||15) && (
                        <button onClick={()=>setZonaVer(p=>({...p,[zona]:(p[zona]||15)+15}))}
                          className="w-full mb-2 px-3 py-2 rounded-lg text-xs font-bold border-2 border-[#5b21b6] text-[#5b21b6] bg-white active:scale-95 transition">
                          ▾ Mostrar 15 más ({lista.length-(zonaVer[zona]||15)} restantes)
                        </button>
                      )}
                      <a href={rutaMapsLink(lista.filter(c=>dirSuficiente(c)))} target="_blank" rel="noreferrer"
                        className={`block w-full text-center px-3 py-2 rounded-lg text-xs font-bold text-white ${lista.filter(c=>dirSuficiente(c)).length>0?"":"opacity-40 pointer-events-none"}`} style={{background:"#1a73e8"}}>
                        <Ico e="🗺" className="mr-1.5" />Ver {etiquetaDe(zona)} en Google Maps
                      </a>
                      <div className="text-[10px] text-slate-400 text-center mt-1.5"><Ico e="💡" className="mr-1.5" />Para guardar esta zona como ruta, ve a la pestaña 🗺️ Rutas → Crear ruta → Por {zonaModo==="ciudad"?"ciudad":"ZIP"}</div>
                    </div>
                  )}
                </div>
              );
            })}
            {todosClientes.length===0 && (
              <div className="bg-white rounded-2xl p-8 text-center shadow-sm border border-[#e8edf3]">
                <div className="mb-2 flex justify-center"><Ico e="📍" size={36} strokeWidth={1.25} className="opacity-40" /></div>
                <div className="text-sm text-slate-400">Aún no hay clientes con zona registrada.</div>
              </div>
            )}
          </div>
        );
      })()}

      {subTab==="pendientes" && (
        <>
          {hayFiltro && <div className="mb-3 text-xs font-bold text-[#5b21b6]">Mostrando {pendientes.length} de {pendientesAll.length} pendientes</div>}

          {pendientes.length===0
            ? <div className="text-center py-14 text-slate-400"><div className="mb-3 flex justify-center"><Ico e={pendientesAll.length===0?"✅":"🔍"} size={40} strokeWidth={1.25} className="opacity-40" /></div><div className="text-sm font-bold">{pendientesAll.length===0?"¡No hay llamadas pendientes!":"Ningún pendiente con ese filtro"}</div></div>
            : <div className="space-y-3">{pendientes.map((c,_i)=>(<ClientRow key={`pend-${_i}-${c._tipo}-${String(c.id)}`} c={c} type={c._tipo==="referidos"?"referido-llamada":c._tipo} role={role} onStatusChange={(id,status)=>updateStatus(id,c._tipo,status)} onEdit={cc=>editarCliente(cc,c._tipo)} onSchedule={c=>openSchedule(c)} onDelete={id=>eliminarCliente(id,c._tipo)} onCall={onCallLog} onApptResult={handleApptResult} onSaveCallToHistorial={(id,entry)=>saveHistorial(id,c._tipo,entry)} onSaveNota={(id,texto)=>saveNota(id,c._tipo,texto)} agente={agente} onDeleteHistorial={(cid,ekey)=>deleteHist(cid,c._tipo,ekey)} onMarcarLlamado={(id)=>marcarLlamado(id,c._tipo)} />))}</div>}
        </>
      )}

      {subTab==="hoy" && (
        <>
          <div className="mb-3 rounded-xl p-4 text-white flex items-center justify-between" style={{background:`linear-gradient(135deg, ${RP.navy}, ${RP.blue})`}}>
            <div><div className="text-xs font-bold opacity-90">Llamadas realizadas hoy</div><div className="text-3xl font-black" style={{fontFamily:SERIF}}>{llamadasHoy.length}</div></div>
            <div className="opacity-80 flex justify-center"><Ico e="📞" size={44} strokeWidth={1.25} className="opacity-40" /></div>
          </div>
          {llamadasHoy.length===0
            ? <div className="text-center py-10 text-slate-400"><div className="mb-2 flex justify-center"><Ico e="☎" size={36} strokeWidth={1.25} className="opacity-40" /></div><div className="text-sm font-bold">Aún no hay llamadas registradas hoy</div><div className="text-xs mt-1">Registra llamadas desde "Pendientes" con el botón 📞 Resultado</div></div>
            : <div className="space-y-2">{llamadasHoy.map((l,i)=><LlamadaItem key={i} l={l} />)}</div>}
        </>
      )}

      {subTab==="total" && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <div className="bg-white rounded-2xl p-4 text-center shadow-sm border border-[#e8edf3]"><div className="text-3xl font-black text-[#5b21b6]" style={{fontFamily:SERIF}}>{llamadasHoy.length}</div><div className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mt-0.5">Hoy</div></div>
            <div className="bg-white rounded-2xl p-4 text-center shadow-sm border border-[#e8edf3]"><div className="text-3xl font-black text-emerald-700" style={{fontFamily:SERIF}}>{llamadasTotal.length}</div><div className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mt-0.5">Total histórico</div></div>
          </div>
          {llamadasTotal.length===0
            ? <div className="text-center py-10 text-slate-400"><div className="mb-2 flex justify-center"><Ico e="☎" size={36} strokeWidth={1.25} className="opacity-40" /></div><div className="text-sm font-bold">Aún no hay llamadas registradas</div></div>
            : <div className="space-y-2">{llamadasTotal.map((l,i)=><LlamadaItem key={i} l={l} />)}</div>}
        </>
      )}

      {scheduleClient && <Modal title="📅 Agendar" onClose={()=>{setScheduleClient(null);setForceTipo(null);}}><AppointmentForm client={scheduleClient} forceTipo={forceTipo} loading={calLoading} onSave={handleSchedule} onClose={()=>{setScheduleClient(null);setForceTipo(null);}} agenteActivo={agente} /></Modal>}
      {editCall && <Modal title={`✏️ Editar — ${editCall.tipo==="distribucion"?"Distribución":editCall.tipo==="prospectos"?"Prospecto":"Cliente"}`} onClose={()=>setEditCall(null)}><ClientForm initial={editCall.cliente} type={editCall.tipo==="prospectos"?"prospecto":editCall.tipo==="distribucion"?"distribucion":"agregado"} onSave={guardarEdicionCall} onClose={()=>setEditCall(null)} /></Modal>}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────
// ─── RECLUTAMIENTO ────────────────────────────────────────────
const RECLU_RESULTADOS = ["Pendiente","Nuevo socio","No contratado","No se presentó","2da entrevista"];
const RECLU_RES_STYLE = {
  "Pendiente":      { bg:"#fef3e2", c:"#b45309" },
  "Nuevo socio":    { bg:"#e7f6ec", c:"#047857" },
  "No contratado":  { bg:"#fde8e8", c:"#dc2626" },
  "No se presentó": { bg:"#f1f5f9", c:"#64748b" },
  "2da entrevista": { bg:"#f1ecfd", c:"#5b21b6" },
};
// Mensaje persuasivo de oportunidad laboral (WhatsApp/SMS)
const recluMsg = (nombre) => {
  const primer = (nombre||"").split(" ")[0] || nombre || "";
  return encodeURIComponent(`¡Hola ${primer}! 👋 Te escribo de Impact Enterprises. Estamos creciendo y buscamos personas con buena actitud para una oportunidad con ingresos por encima del promedio, horario flexible y crecimiento real — no necesitas experiencia, nosotros te capacitamos. Me encantaría contarte los detalles en una entrevista corta. ¿Qué día de esta semana te queda mejor? 🙌`);
};
const waLinkReclu = (n, nombre) => waLink(n) + "?text=" + recluMsg(nombre);
const smsLinkReclu = (n, nombre) => "sms:" + soloDigitos(n) + "&body=" + recluMsg(nombre);

// Casilla de estadística (número de la semana grande + del mes debajo)
function ReclStat({ label, semana, mes }) {
  return (
    <div className="rounded-xl bg-[#f4f6f9] px-2 py-3 text-center">
      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5 leading-tight">{label}</div>
      <div className="text-2xl font-black text-[#5b21b6] leading-none">{semana}</div>
      <div className="text-[9px] text-slate-400 mt-0.5">esta semana</div>
      <div className="text-base font-bold text-slate-600 mt-2">{mes}</div>
      <div className="text-[9px] text-slate-400">este mes</div>
    </div>
  );
}

// Tarjeta compacta de prospecto de reclutamiento (se expande al tocar; incluye nota)
function RecruitCard({ r, onUpdate, onEdit, onDelete, onAgendar }) {
  const [open,setOpen]=useState(false);
  const [nota,setNota]=useState(r.notas||"");
  useEffect(()=>{ setNota(r.notas||""); },[r.notas]);
  const rs=RECLU_RES_STYLE[r.resultado]||RECLU_RES_STYLE["Pendiente"];
  const guardarNota=()=>{ if((nota||"")!==(r.notas||"")) onUpdate(r.id,{notas:nota}); };
  return (
    <div className="bg-white rounded-xl border border-[#e8edf3] shadow-sm">
      {/* Fila compacta */}
      <div className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none active:bg-black/5 rounded-xl" onClick={()=>setOpen(o=>!o)}>
        <div className="min-w-0 flex-1">
          <div className="font-bold text-sm text-[#1f2d3d] truncate">{r.nombre||"(Sin nombre)"}</div>
          <div className="text-[11px] text-slate-400 truncate">{r.telefono||"sin teléfono"}{r.fuente?` · ${r.fuente}`:""}</div>
        </div>
        {r.entrevistado && <span className="text-[11px] shrink-0" title="Entrevistado"><Ico e="✅" /></span>}
        {r.entrevista_agendada && <span className="text-[11px] shrink-0" title="Entrevista agendada"><Ico e="🗓" /></span>}
        {(r.notas||"").trim() && <span className="text-[11px] shrink-0" title="Tiene nota"><Ico e="📝" /></span>}
        <span className="text-[10px] font-bold px-2 py-0.5 rounded-md shrink-0" style={{background:rs.bg,color:rs.c}}>{r.resultado||"Pendiente"}</span>
        {r.telefono && <a onClick={e=>e.stopPropagation()} href={telLink(r.telefono)} className="w-8 h-8 flex items-center justify-center rounded-lg text-white text-sm shrink-0" style={{background:RP.blue}}><Ico e="📞" /></a>}
        {r.telefono && <a onClick={e=>e.stopPropagation()} href={waLinkReclu(r.telefono,r.nombre)} target="_blank" rel="noreferrer" className="w-8 h-8 flex items-center justify-center rounded-lg text-white text-sm shrink-0" style={{background:"#25D366"}}><Ico e="💬" /></a>}
        <span className="text-slate-300 text-xs shrink-0 w-4 text-center">{open?"▲":"▼"}</span>
      </div>

      {/* Expandido */}
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-[#f0f3f7] space-y-2.5">
          {r.telefono && (
            <a href={smsLinkReclu(r.telefono,r.nombre)} className="block text-center text-[#5b21b6] text-xs font-bold px-3 py-2 rounded-lg border border-[#e5def4]"><Ico e="✉" className="mr-1.5" />Enviar SMS de oportunidad</a>
          )}
          {r.entrevista_agendada && (
            <div className="flex items-center gap-2 text-xs font-bold text-teal-700 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2"><Ico e="🗓" className="mr-1.5" />Entrevista: {new Date(r.entrevista_agendada).toLocaleString("es",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</div>
          )}
          {!r.entrevista_agendada ? (
            <button onClick={()=>onAgendar&&onAgendar(r)} className="w-full text-center text-white text-xs font-bold px-3 py-2 rounded-lg" style={{background:"#0d9488"}}><Ico e="🤝" className="mr-1.5" />Agendar entrevista</button>
          ) : (
            <div>
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Resultado de entrevista</div>
              <div className="grid grid-cols-3 gap-1.5">
                <button onClick={()=>onUpdate(r.id,{entrevista_resultado:"entrevistado",entrevistado:true,entrevistado_fecha:r.entrevistado_fecha||new Date().toISOString()})} className={`text-[11px] font-bold px-2 py-2 rounded-lg border-2 ${r.entrevista_resultado==="entrevistado"?"text-white border-transparent":"text-slate-500 border-[#e5def4] bg-white"}`} style={r.entrevista_resultado==="entrevistado"?{background:"#047857"}:{}}><Ico e="✅" className="mr-1.5" />Entrevistado</button>
                <button onClick={()=>onUpdate(r.id,{entrevista_resultado:"no_llego"})} className={`text-[11px] font-bold px-2 py-2 rounded-lg border-2 ${r.entrevista_resultado==="no_llego"?"text-white border-transparent":"text-slate-500 border-[#e5def4] bg-white"}`} style={r.entrevista_resultado==="no_llego"?{background:"#dc2626"}:{}}><Ico e="🚫" className="mr-1.5" />No llegó</button>
                <button onClick={()=>onAgendar&&onAgendar(r)} className="text-[11px] font-bold px-2 py-2 rounded-lg border-2 text-cyan-700 border-cyan-200 bg-cyan-50"><Ico e="🔄" className="mr-1.5" />Reset</button>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={()=>onUpdate(r.id, r.entrevistado?{entrevistado:false}:{entrevistado:true,entrevistado_fecha:new Date().toISOString()})} className={`text-[11px] font-bold px-2.5 py-1.5 rounded-lg border ${r.entrevistado?"bg-emerald-50 text-emerald-700 border-emerald-200":"bg-[#f4f6f9] text-slate-500 border-[#e5def4]"}`}>{r.entrevistado?<><Ico e="✅" className="mr-1" />Entrevistado</>:<><Ico e="⬜" className="mr-1" />Sin entrevistar</>}</button>
            <select value={r.resultado||"Pendiente"} onChange={e=>{const v=e.target.value; onUpdate(r.id, v==="Nuevo socio"?{resultado:v,socio_fecha:r.socio_fecha||new Date().toISOString()}:{resultado:v});}} className="text-[11px] font-bold border-2 border-[#e5def4] rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:border-[#7c3aed]">
              {RECLU_RESULTADOS.map(op=><option key={op} value={op}>{op}</option>)}
            </select>
          </div>
          <textarea value={nota} onChange={e=>setNota(e.target.value)} onBlur={guardarNota} rows={2}
            className="w-full border-2 border-[#e5def4] rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-[#7c3aed] resize-none"
            placeholder="Nota o detalles del prospecto…" />
          <div className="flex items-center justify-between">
            <div className="flex gap-1.5">
              <button onClick={()=>onEdit(r)} className="text-xs px-3 py-1.5 rounded-md bg-[#f4f6f9] text-slate-700 font-bold border border-[#e5def4]"><Ico e="✏" className="mr-1.5" />Editar</button>
              <button onClick={()=>onDelete(r.id)} className="text-xs px-3 py-1.5 rounded-md bg-red-50 text-red-500 font-bold"><Ico e="🗑" /></button>
            </div>
            <div className="text-[10px] text-slate-300">La nota se guarda al salir del campo</div>
          </div>
        </div>
      )}
    </div>
  );
}

function EntrevistaModal({ prospecto, agente, onSave, onClose }) {
  const defFecha = new Date(Date.now()+3600000).toISOString().slice(0,16);
  const [f,setF]=useState({
    nombre: prospecto?.nombre||"",
    telefono: prospecto?.telefono||"",
    fecha: defFecha,
    notas: "",
    attendees: TEAM_CONTACTS.filter(c=>c.default.entrevista).map(c=>c.email),
    extraEmail: "",
  });
  const set=(k,v)=>setF(p=>({...p,[k]:v}));
  const toggle=(email)=>setF(p=>({...p, attendees: p.attendees.includes(email)?p.attendees.filter(e=>e!==email):[...p.attendees,email] }));
  const guardar=()=>{
    if(!f.fecha){ alert("📅 Elige la fecha y hora de la entrevista."); return; }
    const extra=(f.extraEmail||"").trim();
    const attendees=[...f.attendees, ...(extra?[extra]:[])].filter(Boolean);
    onSave({ nombre:f.nombre, telefono:f.telefono, fecha:f.fecha, notas:f.notas, attendees });
  };
  return (
    <Modal title="🤝 Agendar entrevista" onClose={onClose}>
      <div className="space-y-2.5">
        <Field label="Nombre"><input className={inpLight} value={f.nombre} onChange={e=>set("nombre",e.target.value)} placeholder="Nombre del prospecto" /></Field>
        <Field label="Teléfono"><input className={inpLight} value={f.telefono} onChange={e=>set("telefono",e.target.value)} placeholder="Teléfono" /></Field>
        <Field label="Fecha y hora"><input type="datetime-local" className={inpLight} value={f.fecha} onChange={e=>set("fecha",e.target.value)} /></Field>
        <Field label="Nota"><textarea className={inpLight+" resize-none"} rows={2} value={f.notas} onChange={e=>set("notas",e.target.value)} placeholder="Ej: Entrevista inicial, llevar presentación…" /></Field>
        <Field label="Invitar al equipo (Google Calendar)">
          <div className="space-y-1.5">
            {TEAM_CONTACTS.map(c=>(
              <button key={c.email} type="button" onClick={()=>toggle(c.email)} className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold border-2 text-left ${f.attendees.includes(c.email)?"border-teal-500 bg-teal-50 text-teal-700":"border-[#e5def4] text-slate-500"}`}>
                <span>{f.attendees.includes(c.email)?"✅":"⬜"}</span>{c.label}
              </button>
            ))}
            <input className={inpLight} value={f.extraEmail} onChange={e=>set("extraEmail",e.target.value)} placeholder="Otro correo (opcional)" inputMode="email" autoCapitalize="off" autoCorrect="off" />
          </div>
        </Field>
        <div className="flex gap-2 pt-1">
          <button onClick={guardar} className="flex-1 px-4 py-2.5 rounded-xl text-sm font-bold text-white" style={{background:"#0d9488"}}><Ico e="📅" className="mr-1.5" />Agendar y abrir Calendar</button>
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl text-sm font-bold text-slate-500 bg-[#f4f6f9] border border-[#e5def4]">Cancelar</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Compresión de archivos para socios (imagen → JPEG ~100 KB; PDF ≤ 300 KB) ──
const comprimirArchivoSocio = (file) => new Promise((resolve, reject) => {
  if(file.type === "application/pdf"){
    if(file.size > 300*1024) return reject(new Error("El PDF pesa más de 300 KB. Súbelo como foto o comprímelo primero."));
    const r=new FileReader(); r.onload=()=>resolve({ n:file.name, t:file.type, b64:String(r.result).split(",")[1] });
    r.onerror=()=>reject(new Error("No se pudo leer el archivo")); r.readAsDataURL(file); return;
  }
  const r=new FileReader();
  r.onload=()=>{
    const img=new Image();
    img.onload=()=>{
      const MAX=1000; let w=img.width,h=img.height;
      if(Math.max(w,h)>MAX){ const k=MAX/Math.max(w,h); w=Math.round(w*k); h=Math.round(h*k); }
      const cv=document.createElement("canvas"); cv.width=w; cv.height=h;
      cv.getContext("2d").drawImage(img,0,0,w,h);
      const data=cv.toDataURL("image/jpeg",0.55);
      resolve({ n:(file.name||"foto").replace(/\.[^.]+$/,"")+".jpg", t:"image/jpeg", b64:data.split(",")[1] });
    };
    img.onerror=()=>reject(new Error("Imagen inválida"));
    img.src=String(r.result);
  };
  r.onerror=()=>reject(new Error("No se pudo leer el archivo"));
  r.readAsDataURL(file);
});
const verArchivoSocio = (f) => {
  try{
    const bin=atob(f.b64); const arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
    const url=URL.createObjectURL(new Blob([arr],{type:f.t}));
    window.open(url,"_blank");
  }catch(e){ alert("No se pudo abrir el archivo"); }
};

// ── Panel de SOCIOS NUEVOS (datos + ID y Acuerdo de emprendedor opcionales) ──
function SociosPanel({ socios, setSocios, docsSocios, setDocsSocios, agente }){
  const [showForm,setShowForm]=useState(false);
  const [editId,setEditId]=useState(null);
  const [f,setF]=useState({nombre:"",apellido:"",telefono:"",direccion:"",correo:"",fechaInicio:""});
  const [busca,setBusca]=useState("");
  const [subiendo,setSubiendo]=useState("");
  const set=(k,v)=>setF(p=>({...p,[k]:v}));
  const abrirNuevo=()=>{ setF({nombre:"",apellido:"",telefono:"",direccion:"",correo:"",fechaInicio:hoyLocal()}); setEditId(null); setShowForm(true); };
  const abrirEditar=(x)=>{ setF({nombre:x.nombre||"",apellido:x.apellido||"",telefono:x.telefono||"",direccion:x.direccion||"",correo:x.correo||"",fechaInicio:x.fechaInicio||""}); setEditId(x.id); setShowForm(true); };
  const guardar=()=>{
    if(!f.nombre.trim()||!f.apellido.trim()){ alert("✍️ Nombre y apellido son obligatorios."); return; }
    if((f.telefono||"").replace(/\D/g,"").length<10){ alert("📞 Teléfono válido (10 dígitos) es obligatorio."); return; }
    if(editId) setSocios(p=>p.map(x=>x.id===editId?{...x,...f}:x));
    else setSocios(p=>[...(p||[]),{id:genId(),...f,registradoPor:agente,creado:new Date().toISOString()}]);
    setShowForm(false);
  };
  const subirDoc=(socioId, slot)=>{
    const inp=document.createElement("input");
    inp.type="file"; inp.accept="image/*,application/pdf";
    inp.onchange=async(e)=>{
      const file=e.target.files?.[0]; if(!file) return;
      setSubiendo(socioId+slot);
      try{
        const comp=await comprimirArchivoSocio(file);
        setDocsSocios(p=>({...(p||{}),[socioId]:{...((p||{})[socioId]||{}),[slot]:comp}}));
      }catch(err){ alert("⚠️ "+(err.message||err)); }
      setSubiendo("");
    };
    inp.click();
  };
  const quitarDoc=(socioId,slot)=>{
    if(!confirm("¿Quitar este archivo?")) return;
    setDocsSocios(p=>{ const d={...(p||{})}; const so={...(d[socioId]||{})}; delete so[slot]; if(Object.keys(so).length) d[socioId]=so; else delete d[socioId]; return d; });
  };
  const lista=(socios||[]).filter(x=>{
    const q=(busca||"").toLowerCase();
    return !q || (x.nombre+" "+x.apellido).toLowerCase().includes(q) || (x.telefono||"").includes(q);
  }).sort((a,b)=>(b.fechaInicio||"").localeCompare(a.fechaInicio||""));
  const SLOTS=[["idDoc","🪪 ID"],["contrato","📜 Acuerdo de emprendedor"]];
  return (
    <div>
      <div className="flex gap-2 mb-3">
        <input className={inpLight+" flex-1"} placeholder="Buscar socio…" value={busca} onChange={e=>setBusca(e.target.value)} />
        <button onClick={abrirNuevo} className="px-4 py-2 rounded-lg text-sm font-bold text-white shrink-0" style={{background:RP.navy}}>+ Socio</button>
      </div>
      {lista.length===0 && <div className="text-center py-12 text-slate-400"><div className="mb-3 flex justify-center"><Ico e="🤝" size={36} strokeWidth={1.25} className="opacity-40" /></div><div className="text-sm font-bold">Sin socios registrados.</div><div className="text-xs mt-1">Toca "+ Socio" para registrar al primero.</div></div>}
      <div className="space-y-2">
        {lista.map(x=>{
          const docs=(docsSocios||{})[x.id]||{};
          return (
            <div key={x.id} className="bg-white rounded-2xl border border-[#e8edf3] p-3 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm text-[#1f2d3d]" style={{fontFamily:SERIF}}><Ico e="🤝" className="mr-1.5" />{x.nombre} {x.apellido}</div>
                  <div className="text-xs text-slate-500 mt-0.5"><Ico e="📞" className="mr-1.5" />{x.telefono||"—"} {x.correo?` · ✉️ ${x.correo}`:""}</div>
                  {x.direccion && <div className="text-xs text-slate-400"><Ico e="📍" className="mr-1.5" />{x.direccion}</div>}
                  {x.fechaInicio && <div className="text-[11px] text-emerald-600 font-bold mt-0.5"><Ico e="🚀" className="mr-1.5" />Inició: {x.fechaInicio}</div>}
                </div>
                <div className="flex gap-1 shrink-0">
                  {(x.telefono||"").replace(/\D/g,"") && <a href={`https://wa.me/${(x.telefono||"").replace(/\D/g,"")}`} target="_blank" rel="noreferrer" className="w-8 h-8 flex items-center justify-center rounded-lg text-white text-sm" style={{background:"#25D366"}}>💬</a>}
                  <button onClick={()=>abrirEditar(x)} className="w-8 h-8 flex items-center justify-center rounded-lg bg-[#f4f6f9] text-sm"><Ico e="✏" /></button>
                  <button onClick={()=>{ if(confirm("¿Eliminar este socio y sus archivos?")){ setSocios(p=>p.filter(y=>y.id!==x.id)); setDocsSocios(p=>{const d={...(p||{})}; delete d[x.id]; return d;}); } }} className="w-8 h-8 flex items-center justify-center rounded-lg bg-red-50 text-sm"><Ico e="🗑" /></button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {SLOTS.map(([slot,label])=>(
                  <div key={slot} className="rounded-xl border border-[#e8edf3] bg-[#fafbfc] p-2">
                    <div className="text-[10px] font-black text-slate-500 uppercase tracking-wide mb-1">{label} <span className="font-normal normal-case">(opcional)</span></div>
                    {docs[slot] ? (
                      <div className="flex items-center gap-1.5">
                        <button onClick={()=>verArchivoSocio(docs[slot])} className="flex-1 text-left text-[11px] font-bold text-[#5b21b6] truncate underline">{docs[slot].n}</button>
                        <button onClick={()=>quitarDoc(x.id,slot)} className="text-red-400 text-xs font-bold px-1"><Ico e="✕" /></button>
                      </div>
                    ) : (
                      <button onClick={()=>subirDoc(x.id,slot)} disabled={subiendo===x.id+slot}
                        className="w-full py-1.5 rounded-lg text-[11px] font-bold border-2 border-dashed border-[#c9b8f0] text-[#5b21b6]">
                        {subiendo===x.id+slot?"Comprimiendo…":<><Ico e="⬆" className="mr-1" />Subir foto o PDF</>}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {showForm && (
        <Modal title={editId?<><Ico e="✏" className="mr-1" />Editar socio</>:<><Ico e="🤝" className="mr-1" />Nuevo socio</>} onClose={()=>setShowForm(false)}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nombre" required><input className={inpLight} value={f.nombre} onChange={e=>set("nombre",e.target.value)} /></Field>
            <Field label="Apellido" required><input className={inpLight} value={f.apellido} onChange={e=>set("apellido",e.target.value)} /></Field>
          </div>
          <Field label="Teléfono" required><input className={inpLight} value={f.telefono} onChange={e=>set("telefono",e.target.value)} inputMode="tel" /></Field>
          <Field label="Dirección"><input className={inpLight} value={f.direccion} onChange={e=>set("direccion",e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Correo electrónico"><input className={inpLight} value={f.correo} onChange={e=>set("correo",e.target.value)} inputMode="email" autoCapitalize="off" /></Field>
            <Field label="Fecha de inicio"><input type="date" className={inpLight} value={f.fechaInicio} onChange={e=>set("fechaInicio",e.target.value)} /></Field>
          </div>
          <div className="text-[11px] text-slate-400 mb-3">El ID y el Acuerdo de emprendedor se suben desde la tarjeta del socio después de guardarlo.</div>
          <button onClick={guardar} className="w-full py-3 rounded-xl text-sm font-bold text-white" style={{background:RP.navy}}><Ico e="✅" className="mr-1.5" />Guardar socio</button>
        </Modal>
      )}
    </div>
  );
}

function RecruitmentSection({ reclutamiento, setReclutamiento, agente, notify, rolActivo, setAppts, socios, setSocios, docsSocios, setDocsSocios }) {
  const [showForm,setShowForm]=useState(false);
  const [editId,setEditId]=useState(null);
  const [tab,setTab]=useState("todos"); // todos | entrevistas
  const [form,setForm]=useState({nombre:"",telefono:"",fuente:"",entrevistado:false,resultado:"Pendiente"});
  const [busca,setBusca]=useState("");

  const abrirNuevo=()=>{ setForm({nombre:"",telefono:"",fuente:"",entrevistado:false,resultado:"Pendiente"}); setEditId(null); setShowForm(true); };
  const abrirEditar=(r)=>{ setForm({nombre:r.nombre||"",telefono:r.telefono||"",fuente:r.fuente||"",entrevistado:!!r.entrevistado,resultado:r.resultado||"Pendiente"}); setEditId(r.id); setShowForm(true); };
  const guardar=()=>{
    if(!form.nombre.trim() && soloDigitos(form.telefono).length<10){ alert("📝 Pon al menos un nombre o un teléfono válido (10 dígitos)."); return; }
    const ahora=new Date().toISOString();
    if(editId){
      setReclutamiento(p=>p.map(r=>{
        if(r.id!==editId) return r;
        const patch={...form,actualizado:ahora};
        if(form.entrevistado && !r.entrevistado_fecha) patch.entrevistado_fecha=ahora;
        if(form.resultado==="Nuevo socio" && !r.socio_fecha) patch.socio_fecha=ahora;
        return {...r,...patch};
      }));
    } else {
      const nuevo={id:genId(),...form,creado:ahora};
      if(form.entrevistado) nuevo.entrevistado_fecha=ahora;
      if(form.resultado==="Nuevo socio") nuevo.socio_fecha=ahora;
      setReclutamiento(p=>[nuevo,...p]);
      if(notify) notify("reclutamiento",`🧲 Nuevo prospecto de reclutamiento: ${form.nombre||form.telefono}`,`Fuente: ${form.fuente||"—"}`,"Reclutamiento");
    }
    setShowForm(false); setEditId(null);
  };
  const borrar=(id)=>{ if(window.confirm("¿Eliminar este prospecto de reclutamiento?")) setReclutamiento(p=>p.filter(r=>r.id!==id)); };
  const setCampo=(id,patch)=>setReclutamiento(p=>p.map(r=>r.id===id?{...r,...patch,actualizado:new Date().toISOString()}:r));
  const [agendarPros,setAgendarPros]=useState(null);
  const onAgendarEntrevista=(datos)=>{
    const appt={ id:genId(), tipo:"entrevista", _type:"entrevista", nombre:datos.nombre, telefono:datos.telefono, fecha:datos.fecha, notas:datos.notas, attendees:datos.attendees, agente:agente||"" };
    if(setAppts) setAppts(p=>[appt,...p]);
    if(agendarPros?.id) setCampo(agendarPros.id,{ entrevista_agendada:datos.fecha });
    try{ window.open(gcalLink(appt),"_blank"); }catch(e){}
    if(notify) notify("reclutamiento",`🤝 Entrevista agendada: ${datos.nombre||datos.telefono}`,`📅 ${new Date(datos.fecha).toLocaleString("es")}`,"Reclutamiento");
    setAgendarPros(null);
  };

  const q=(busca||"").toLowerCase().trim(); const qNum=soloDigitos(busca);
  const lista=(reclutamiento||[]).filter(r=>{
    if(!q) return true;
    const nombre=(r.nombre||"").toLowerCase();
    const fuente=(r.fuente||"").toLowerCase();
    const tel=soloDigitos(r.telefono);
    return nombre.includes(q)||fuente.includes(q)||(qNum.length>=3 && tel.includes(qNum));
  });

  // ── Estadísticas (esta semana / este mes) ──
  const _now=new Date();
  const _inicioSemana=(()=>{ const d=new Date(_now); const dia=(d.getDay()+6)%7; d.setHours(0,0,0,0); d.setDate(d.getDate()-dia); return d; })();
  const _inicioMes=new Date(_now.getFullYear(), _now.getMonth(), 1);
  const _enRango=(iso,desde)=>{ if(!iso) return false; const t=new Date(iso); return !isNaN(t.getTime()) && t>=desde; };
  const _arr=reclutamiento||[];
  const stats={
    entSemana:_arr.filter(r=>r.entrevistado && _enRango(r.entrevistado_fecha,_inicioSemana)).length,
    entMes:_arr.filter(r=>r.entrevistado && _enRango(r.entrevistado_fecha,_inicioMes)).length,
    prosSemana:_arr.filter(r=>_enRango(r.creado,_inicioSemana)).length,
    prosMes:_arr.filter(r=>_enRango(r.creado,_inicioMes)).length,
    sociosSemana:_arr.filter(r=>r.resultado==="Nuevo socio" && _enRango(r.socio_fecha,_inicioSemana)).length,
    sociosMes:_arr.filter(r=>r.resultado==="Nuevo socio" && _enRango(r.socio_fecha,_inicioMes)).length,
  };

  return (
    <div className="space-y-4">
      {/* Panel de estadísticas */}
      <div className="bg-white rounded-2xl border border-[#e8edf3] p-4 shadow-sm">
        <div className="text-sm font-bold text-[#1f2d3d] mb-3"><Ico e="📊" className="mr-1.5" />Estadísticas de reclutamiento</div>
        <div className="grid grid-cols-3 gap-2">
          <ReclStat label="Entrevistas" semana={stats.entSemana} mes={stats.entMes} />
          <ReclStat label="Prospectos nuevos" semana={stats.prosSemana} mes={stats.prosMes} />
          <ReclStat label="Nuevos socios" semana={stats.sociosSemana} mes={stats.sociosMes} />
        </div>
      </div>

      {/* Pestañas: Todos / Entrevistas */}
      <div className="flex gap-1.5">
        {[{id:"todos",ico:"🧲", label:"Todos",n:(reclutamiento||[]).length},{id:"entrevistas",ico:"🤝", label:"Entrevistas",n:(reclutamiento||[]).filter(r=>r.entrevista_agendada).length},{id:"socios",ico:"⭐", label:"Socios",n:(socios||[]).length}].map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            className={`flex-1 px-3 py-2.5 rounded-xl text-sm font-bold transition flex items-center justify-center gap-1.5 ${tab===t.id?"text-white":"text-slate-600 bg-[#f4f6f9]"}`}
            style={tab===t.id?{background:RP.navy}:{}}>
            {t.label}<span className={`text-[10px] px-1.5 py-0.5 rounded-full ${tab===t.id?"bg-white/25":"bg-white"}`}>{t.n}</span>
          </button>
        ))}
      </div>

      {tab!=="socios" && <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-slate-500 font-bold">{(reclutamiento||[]).length} prospecto(s) de reclutamiento</div>
        <button onClick={abrirNuevo} className="text-sm font-bold text-white px-4 py-2 rounded-xl" style={{background:RP.navy}}>+ Nuevo</button>
      </div>}

      {tab!=="socios" && <input className={inpLight} placeholder="Buscar por nombre o teléfono…" name="buscar-reclu" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} value={busca} onChange={e=>setBusca(e.target.value)} />}

      {showForm && (
        <div className="bg-white rounded-2xl border border-[#e8edf3] p-4 shadow-sm space-y-2.5">
          <Field label="Nombre"><input className={inpLight} value={form.nombre} onChange={e=>setForm(f=>({...f,nombre:e.target.value}))} placeholder="Nombre del prospecto" /></Field>
          <Field label="Teléfono"><input className={inpLight} value={form.telefono} onChange={e=>setForm(f=>({...f,telefono:e.target.value}))} placeholder="Teléfono" /></Field>
          <Field label="Fuente"><input className={inpLight} value={form.fuente} onChange={e=>setForm(f=>({...f,fuente:e.target.value}))} placeholder="ej. Facebook, referido, volante…" /></Field>
          <div className="flex items-center gap-2">
            <button type="button" onClick={()=>setForm(f=>({...f,entrevistado:!f.entrevistado}))} className={`px-3 py-2 rounded-lg text-sm font-bold border-2 ${form.entrevistado?"border-emerald-500 bg-emerald-50 text-emerald-700":"border-[#e5def4] text-slate-500"}`}>{form.entrevistado?<><Ico e="✅" className="mr-1" />Entrevistado</>:"¿Ya fue entrevistado?"}</button>
          </div>
          <Field label="Resultado de entrevista">
            <div className="grid grid-cols-2 gap-1.5">
              {RECLU_RESULTADOS.map(r=>(
                <button key={r} type="button" onClick={()=>setForm(f=>({...f,resultado:r}))} className={`px-2 py-2 rounded-lg text-[11px] font-bold border-2 ${form.resultado===r?"border-[#5b21b6] bg-[#5b21b6]/5 text-[#5b21b6]":"border-[#e5def4] text-slate-500"}`}>{r}</button>
              ))}
            </div>
          </Field>
          <div className="flex gap-2">
            <button onClick={guardar} className="flex-1 px-4 py-2.5 rounded-xl text-sm font-bold text-white" style={{background:"#16a34a"}}>{editId?<><Ico e="💾" className="mr-1" />Guardar</>:<><Ico e="✅" className="mr-1" />Agregar</>}</button>
            <button onClick={()=>{setShowForm(false);setEditId(null);}} className="px-4 py-2.5 rounded-xl text-sm font-bold text-slate-500 bg-[#f4f6f9] border border-[#e5def4]">Cancelar</button>
          </div>
        </div>
      )}

      {(() => {
        if(tab==="socios") return <SociosPanel socios={socios} setSocios={setSocios} docsSocios={docsSocios} setDocsSocios={setDocsSocios} agente={agente} />;
        const listaMostrar = tab==="entrevistas" ? lista.filter(r=>r.entrevista_agendada) : lista;
        if(listaMostrar.length===0) return (
          <div className="text-center py-12 text-slate-400"><div className="mb-3 flex justify-center"><Ico e={tab==="entrevistas"?"🤝":"🧲"} size={36} strokeWidth={1.25} className="opacity-40" /></div><div className="text-sm font-bold">{tab==="entrevistas"?"Sin entrevistas agendadas.":"Sin prospectos de reclutamiento."}</div><div className="text-xs mt-1">{tab==="entrevistas"?"Agenda una entrevista desde un prospecto en \"Todos\".":"Toca \"+ Nuevo\" para agregar el primero."}</div></div>
        );
        return listaMostrar.map(r=><RecruitCard key={r.id} r={r} onUpdate={setCampo} onEdit={abrirEditar} onDelete={borrar} onAgendar={setAgendarPros} />);
      })()}
      {agendarPros && <EntrevistaModal prospecto={agendarPros} agente={agente} onSave={onAgendarEntrevista} onClose={()=>setAgendarPros(null)} />}
    </div>
  );
}

// ─── CONTROL DE ACTIVIDAD (semana / mes) ──────────────────────
function ControlActividad({ allData, appts, reclutamiento, cierres, onGuardarCierre }){
  const ahora = new Date();
  const lunes = lunesDeLaSemana(ahora);
  const domingo = new Date(lunes); domingo.setDate(lunes.getDate()+6); domingo.setHours(23,59,59,999);
  const mesKey = ahora.toISOString().slice(0,7);
  const enSemana = (f)=>{ if(!f) return false; const d=new Date(f); return d>=lunes && d<=domingo; };
  const enMes = (f)=>{ if(!f) return false; return String(f).slice(0,7)===mesKey; };

  const aps = appts||[];
  const refs = allData.referidos||[];
  // Clientes con historial (agregados + prospección + distribución + anfitriones + referidos anidados)
  const clientesHist = [
    ...(allData.agregados||[]),
    ...(allData.prospectos||[]),
    ...(allData.distribucion||[]),
    ...refs,
    ...refs.flatMap(anf=>anf.referidos||[]),
  ];

  const calc = (enP)=>{
    // Citas / entrevistas (por fecha agendada, dentro del periodo)
    const citas = aps.filter(a=>(a.tipo==="cita"||a._type==="cita") && enP(a.fecha)).length;
    // Entrevistas de reclutamiento: Invitados = agendadas · Entrevistas = marcadas "entrevistado"
    const invitados = aps.filter(a=>(a.tipo==="entrevista"||a._type==="entrevista") && enP(a.fecha)).length;
    const entrevistas = (reclutamiento||[]).filter(r=>(r.entrevista_resultado==="entrevistado"||r.entrevistado) && enP(r.entrevista_agendada||r.entrevistado_fecha||r.creado)).length;
    // Servicios realizados (por fecha del servicio)
    const servicios = aps.filter(a=>(a.tipo==="servicio"||a._type==="servicio") && a.servicioResultado==="realizado" && enP(a.fecha)).length;
    // Demos / ventas / volumen — función central (misma que Estadísticas e Incentivos)
    const _vd = contarVentasDemos({ appts:aps, clientes:clientesHist, enP });
    const demos=_vd.demos, ventas=_vd.ventas, volumen=_vd.volumen;
    // Datos (cada referido cuenta, sin contar al anfitrión) por fecha de subida
    let datos = 0;
    datos += (allData.agregados||[]).filter(c=>!c.eliminado && enP(c.creado)).length;
    datos += (allData.prospectos||[]).filter(c=>!c.eliminado && enP(c.creado)).length;
    datos += (allData.distribucion||[]).filter(c=>!c.eliminado && enP(c.creado)).length;
    refs.forEach(anf=>{ if(!anf.eliminado)(anf.referidos||[]).forEach(r=>{ if(enP(r.creado||anf.creado)) datos++; }); });
    // Prospectos socio (Reclutamiento) por fecha de subida
    const prospectosSocio = (reclutamiento||[]).filter(r=>enP(r.creado)).length;
    // Socio nuevo (Reclutamiento marcado "Nuevo socio") por fecha
    const socioNuevo = (reclutamiento||[]).filter(r=>r.resultado==="Nuevo socio" && enP(r.socio_fecha||r.creado)).length;
    return { citas, demos, ventas, volumen, servicios, datos, prospectosSocio, invitados, entrevistas, socioNuevo };
  };

  const sem = calc(enSemana);
  const mes = calc(enMes);

  const METRICAS = [
    {key:"citas", icon:"📅", label:"Citas"},
    {key:"demos", icon:"🎬", label:"Demostraciones"},
    {key:"ventas", icon:"💰", label:"Ventas"},
    {key:"volumen", icon:"💵", label:"Volumen de venta", money:true},
    {key:"servicios", icon:"🔧", label:"Servicios"},
    {key:"datos", icon:"📇", label:"Datos"},
    {key:"prospectosSocio", icon:"🧲", label:"Prospectos socio"},
    {key:"invitados", icon:"📨", label:"Invitados"},
    {key:"entrevistas", icon:"🤝", label:"Entrevistas"},
    {key:"socioNuevo", icon:"🌟", label:"Socio nuevo"},
  ];
  const fmt = (m,money)=> money ? `$${(Number(m)||0).toLocaleString("en-US")}` : (Number(m)||0).toLocaleString("en-US");
  const rangoSemana = `${lunes.toLocaleDateString("es-MX",{day:"numeric",month:"short"})} – ${domingo.toLocaleDateString("es-MX",{day:"numeric",month:"short"})}`;
  const rangoMes = ahora.toLocaleDateString("es-MX",{month:"long",year:"numeric"});

  // ── HISTÓRICO ANUAL (mes a mes) + cierre de año ──
  const [vista,setVista]=useState("resumen"); // resumen | historico
  const añoActual=ahora.getFullYear();
  const [yearSel,setYearSel]=useState(añoActual);
  const computeMeses=(Y)=>{
    const out=[];
    for(let m=1;m<=12;m++){
      const mm=String(m).padStart(2,"0");
      const d=calc((f)=>f && String(f).slice(0,7)===`${Y}-${mm}`);
      if(d.citas||d.demos||d.ventas||d.volumen||d.servicios||d.datos||d.prospectosSocio||d.invitados||d.entrevistas||d.socioNuevo)
        out.push({ mes:`${Y}-${mm}`, label:new Date(Y,m-1,1).toLocaleDateString("es-MX",{month:"long"}), ...d });
    }
    return out;
  };
  const computeTotal=(Y)=>calc((f)=>f && String(f).slice(0,4)===String(Y));
  const añosSet=new Set([añoActual]);
  (appts||[]).forEach(a=>{ if(a.fecha) añosSet.add(+String(a.fecha).slice(0,4)); });
  (reclutamiento||[]).forEach(r=>{ if(r.creado) añosSet.add(+String(r.creado).slice(0,4)); });
  ["agregados","prospectos","distribucion"].forEach(g=>(allData[g]||[]).forEach(c=>{ if(c.creado) añosSet.add(+String(c.creado).slice(0,4)); }));
  (cierres||[]).forEach(c=>añosSet.add(c.año));
  const años=[...añosSet].filter(y=>y>2000 && y<2100).sort((a,b)=>b-a);
  const cierreSel=(cierres||[]).find(c=>c.año===yearSel);
  const mesesDelAño = cierreSel ? (cierreSel.meses||[]) : computeMeses(yearSel);
  const totalDelAño = cierreSel ? (cierreSel.total||{}) : computeTotal(yearSel);
  const recordarCierre = ahora.getMonth()===11 || ahora.getMonth()===0; // diciembre o enero

  const exportarPDF=(Y, meses, total)=>{
    const cols=METRICAS;
    const head=cols.map(m=>`<th>${m.label}</th>`).join("");
    const filas=(meses||[]).map(me=>`<tr><td style="text-transform:capitalize;font-weight:700">${me.label||me.mes}</td>${cols.map(m=>`<td style="text-align:right">${fmt(me[m.key],m.money)}</td>`).join("")}</tr>`).join("");
    const totalRow=`<tr style="font-weight:800;background:#f1ecfd"><td>TOTAL ${Y}</td>${cols.map(m=>`<td style="text-align:right">${fmt((total||{})[m.key],m.money)}</td>`).join("")}</tr>`;
    const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Control de actividad ${Y}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin:0;padding:18px;color:#1f2d3d}h1{font-size:20px;margin:0 0 4px}.sub{color:#64748b;font-size:12px;margin-bottom:16px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #e5def4;padding:6px 8px}th{background:#5b21b6;color:#fff;text-align:left}td:first-child,th:first-child{text-align:left}tr:nth-child(even) td{background:#faf8ff}.noprint{position:fixed;top:12px;right:12px;display:flex;gap:8px;z-index:9}@media print{.noprint{display:none}}@page{size:A4 landscape;margin:12mm}</style></head><body><div class="noprint"><button onclick="window.print()" style="background:#5b21b6;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer">🖨️ Guardar PDF</button><button onclick="window.close()" style="background:#e2e8f0;color:#475569;border:none;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer">✕ Cerrar</button></div><h1>📈 Control de actividad — ${Y}</h1><div class="sub">Impact Enterprises · generado ${new Date().toLocaleDateString("es-MX",{day:"numeric",month:"long",year:"numeric"})}</div><table><thead><tr><th>Mes</th>${head}</tr></thead><tbody>${filas||`<tr><td colspan="${cols.length+1}" style="text-align:center;color:#94a3b8">Sin actividad registrada en ${Y}</td></tr>`}${totalRow}</tbody></table></body></html>`;
    try{
      const blob=new Blob([html],{type:"text/html"});
      const url=URL.createObjectURL(blob);
      const w=window.open(url,"_blank");
      if(!w){ const a=document.createElement("a"); a.href=url; a.download=`ControlActividad_${Y}.html`; document.body.appendChild(a); a.click(); document.body.removeChild(a); }
      setTimeout(()=>URL.revokeObjectURL(url),60000);
    }catch(e){ alert("No se pudo generar el PDF: "+((e&&e.message)||e)); }
  };
  const cerrarAño=(Y)=>{
    const meses=computeMeses(Y), total=computeTotal(Y);
    if(!window.confirm(`📄 Antes de cerrar ${Y}, te recomiendo exportar el PDF para guardar tus números.\n\n¿Generar el PDF y guardar el cierre de ${Y}? Quedará disponible siempre en "Años cerrados".`)) return;
    exportarPDF(Y, meses, total);
    if(onGuardarCierre) onGuardarCierre({ id:genId(), año:Y, fecha:new Date().toISOString(), total, meses });
    setTimeout(()=>alert(`✅ Cierre de ${Y} guardado.`), 400);
  };

  const Col = ({titulo, sub, datos:d, accent}) => (
    <div className="flex-1 min-w-0 bg-white rounded-2xl border border-[#e5def4] shadow-sm overflow-hidden">
      <div className="px-3 py-3 text-white" style={{background:accent}}>
        <div className="text-sm font-extrabold leading-tight">{titulo}</div>
        <div className="text-[11px] opacity-90 capitalize">{sub}</div>
      </div>
      <div className="divide-y divide-[#f0ecf9]">
        {METRICAS.map(m=>(
          <div key={m.key} className="flex items-center gap-1.5 px-2.5 py-2.5">
            <span className="w-5 flex items-center justify-center shrink-0">{<Ico e={m.icon} size={15} />}</span>
            <span className="text-[11px] text-slate-500 flex-1 min-w-0 leading-tight">{m.label}</span>
            <span className="text-sm font-extrabold text-[#1f2d3d] shrink-0">{fmt(d[m.key], m.money)}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto px-3 py-4">
      <div className="mb-3">
        <h2 className="text-lg font-extrabold text-[#1f2d3d]"><Ico e="📈" className="mr-1.5" />Control de actividad</h2>
        <p className="text-xs text-slate-400">Totales del distribuidor · se actualiza solo</p>
      </div>

      {/* Toggle Resumen / Histórico */}
      <div className="flex gap-1.5 mb-4">
        <button onClick={()=>setVista("resumen")} className={`flex-1 px-3 py-2.5 rounded-xl text-sm font-bold transition ${vista==="resumen"?"text-white":"text-slate-600 bg-[#f4f6f9]"}`} style={vista==="resumen"?{background:RP.navy}:{}}><Ico e="📊" className="mr-1.5" />Resumen</button>
        <button onClick={()=>setVista("historico")} className={`flex-1 px-3 py-2.5 rounded-xl text-sm font-bold transition ${vista==="historico"?"text-white":"text-slate-600 bg-[#f4f6f9]"}`} style={vista==="historico"?{background:RP.navy}:{}}><Ico e="📅" className="mr-1.5" />Histórico</button>
      </div>

      {vista==="resumen" && (
        <>
          <div className="flex gap-2.5">
            <Col titulo="📅 Esta semana" sub={rangoSemana} datos={sem} accent="#5b21b6" />
            <Col titulo="🗓️ Este mes" sub={rangoMes} datos={mes} accent="#7c3aed" />
          </div>
          <p className="text-[10px] text-slate-300 mt-3 text-center">Citas y entrevistas se cuentan por fecha agendada · datos/prospectos por fecha de subida · ventas por fecha de la cita</p>
        </>
      )}

      {vista==="historico" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <select value={yearSel} onChange={e=>setYearSel(+e.target.value)} className="flex-1 border-2 border-[#e5def4] rounded-lg px-3 py-2 text-sm bg-white font-bold">
              {años.map(y=><option key={y} value={y}>Año {y}{(cierres||[]).some(c=>c.año===y)?" 🔒 cerrado":""}</option>)}
            </select>
            <button onClick={()=>exportarPDF(yearSel, mesesDelAño, totalDelAño)} className="px-3 py-2 rounded-lg text-sm font-bold text-white shrink-0" style={{background:RP.blue}}><Ico e="📄" className="mr-1.5" />PDF</button>
          </div>

          <div className="bg-white rounded-2xl border border-[#e5def4] shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="text-white" style={{background:RP.navy}}>
                    <th className="px-2 py-2 text-left font-bold sticky left-0" style={{background:RP.navy}}>Mes</th>
                    {METRICAS.map(m=><th key={m.key} className="px-2 py-2 text-center font-bold whitespace-nowrap" title={m.label}><Ico e={m.icon} size={15} className="mx-auto" /></th>)}
                  </tr>
                </thead>
                <tbody>
                  {mesesDelAño.length===0
                    ? <tr><td colSpan={METRICAS.length+1} className="px-3 py-6 text-center text-slate-400">Sin actividad registrada en {yearSel}</td></tr>
                    : mesesDelAño.map(me=>(
                      <tr key={me.mes} className="border-t border-[#f0ecf9]">
                        <td className="px-2 py-2 font-bold text-slate-700 capitalize sticky left-0 bg-white whitespace-nowrap">{me.label}</td>
                        {METRICAS.map(m=><td key={m.key} className="px-2 py-2 text-right text-slate-600 whitespace-nowrap">{fmt(me[m.key],m.money)}</td>)}
                      </tr>
                    ))}
                  <tr className="border-t-2 border-[#ddd1f7]" style={{background:"#f1ecfd"}}>
                    <td className="px-2 py-2 font-black text-[#5b21b6] sticky left-0 whitespace-nowrap" style={{background:"#f1ecfd"}}>TOTAL {yearSel}</td>
                    {METRICAS.map(m=><td key={m.key} className="px-2 py-2 text-right font-black text-[#5b21b6] whitespace-nowrap">{fmt(totalDelAño[m.key],m.money)}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[10px] text-slate-400 leading-relaxed">{METRICAS.map(m=>(<span key={m.key} className="inline-flex items-center gap-1"><Ico e={m.icon} size={12} />{m.label}</span>))}</div>

          {!cierreSel
            ? <button onClick={()=>cerrarAño(yearSel)} className={`w-full px-4 py-3 rounded-xl text-sm font-bold text-white ${recordarCierre?"animate-pulse":""}`} style={{background:recordarCierre?"#b45309":"#475569"}}><Ico e="🔒" className="mr-1.5" />Cerrar {yearSel} y exportar PDF</button>
            : <div className="text-center text-xs text-slate-400"><Ico e="🔒" className="mr-1.5" />{yearSel} ya está cerrado · {new Date(cierreSel.fecha).toLocaleDateString("es-MX")}</div>}
          {recordarCierre && !cierreSel && <p className="text-[11px] text-amber-700 text-center font-bold"><Ico e="📅" className="mr-1.5" />Es fin/inicio de año — buen momento para cerrar y guardar tus números en PDF.</p>}
          <p className="text-[10px] text-slate-300 text-center">El histórico se calcula solo de todos tus datos. Al cerrar un año, queda guardado aunque limpies datos después.</p>
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════
// COBRANZA — módulo integrado (clientes sincronizados con Distribución)
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// ── MÓDULO COBRANZA (encapsulado — sin dependencias externas) ──
// ═══════════════════════════════════════════════════════════════
const __CobranzaModule = (function () {
// ── Iconos de línea reales (Lucide). Antes eran emojis dentro de un <span>,
//    lo que rompía la estética y no heredaba el color del texto. Ahora son
//    SVG con trazo uniforme que sí toman currentColor y el tamaño indicado.
const mkIcon = (Comp) => (p) => {
  p = p || {};
  const t = p.size || 15;
  return <Comp className={p.className} width={t} height={t} strokeWidth={1.75}
    style={{ display: "inline-block", verticalAlign: "-0.125em", ...(p.style || {}) }} aria-hidden="true" />;
};
const LayoutDashboard = mkIcon(LU.LayoutDashboard);
const Users = mkIcon(LU.Users);
const DollarSign = mkIcon(LU.DollarSign);
const RefreshCw = mkIcon(LU.RefreshCw);
const FileText = mkIcon(LU.FileText);
const Settings = mkIcon(LU.Settings);
const Search = mkIcon(LU.Search);
const Plus = mkIcon(LU.Plus);
const Phone = mkIcon(LU.Phone);
const MessageCircle = mkIcon(LU.MessageCircle);
const Mail = mkIcon(LU.Mail);
const CheckCircle2 = mkIcon(LU.CheckCircle2);
const XCircle = mkIcon(LU.XCircle);
const AlertTriangle = mkIcon(LU.AlertTriangle);
const ChevronRight = mkIcon(LU.ChevronRight);
const ChevronLeft = mkIcon(LU.ChevronLeft);
const Download = mkIcon(LU.Download);
const Trash2 = mkIcon(LU.Trash2);
const Edit3 = mkIcon(LU.PenLine);
const Undo2 = mkIcon(LU.Undo2);
const CreditCard = mkIcon(LU.CreditCard);
const Calendar = mkIcon(LU.Calendar);
const TrendingUp = mkIcon(LU.TrendingUp);
const Shield = mkIcon(LU.Shield);
const Zap = mkIcon(LU.Zap);
const Clock = mkIcon(LU.Clock);
const Target = mkIcon(LU.Target);
const Camera = mkIcon(LU.Camera);
const Upload = mkIcon(LU.Upload);
const X = mkIcon(LU.X);

const T = {
  bg: "#f0f2f5",
  panel: "#ffffff",
  panel2: "#f0f2f5",
  border: "#d0d4dc",
  borderHi: "#b8cae8",
  blue: "#1a3a6b",
  blueMid: "#2756a8",
  blueLight: "#4a7fd4",
  bluePale: "#e8edf8",
  green: "#1d8a4f",
  greenDim: "#e6f4ec",
  red: "#c0392b",
  yellow: "#c79100",
  orange: "#d97706",
  text: "#2c2c2c",
  mut: "#8a8a8a",
  mono: "'Inter', sans-serif",
  serif: "'Playfair Display', serif",
  glow: "0 2px 12px rgba(26,58,107,.10)",
  glowLg: "0 6px 28px rgba(26,58,107,.14)",
};
const fmt = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayISO = () => new Date().toISOString().slice(0, 10);
const daysSince = (iso) => Math.max(0, Math.floor((new Date(todayISO()).getTime() - new Date(iso).getTime()) / 86400000));
const validPhone = (p) => /^\+?1?\s?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/.test((p || "").trim());
const cleanPhone = (p) => {
  const d = (p || "").replace(/\D/g, "");
  return d.length === 10 ? "1" + d : d;
};
const maskCard = (last4) => "•••• •••• •••• " + (last4 || "????");
const validExp = (e) => {
  const m = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(e || "");
  if (!m) return false;
  const exp = new Date(2000 + +m[2], +m[1], 0);
  return exp >= new Date();
};
const DEFAULT_THRESHOLDS = { verde: 30, amarillo: 60, naranja: 90 };
const semaforoDe = (dias, th) => {
  if (dias <= th.verde) return { key: "verde", label: "AL CORRIENTE", color: T.green, accion: "Seguimiento preventivo" };
  if (dias <= th.amarillo) return { key: "amarillo", label: "MORA 31-60", color: T.yellow, accion: "Recordatorio firme — cuenta ya morosa para Hy Cite" };
  if (dias <= th.naranja) return { key: "naranja", label: "MORA 61-90", color: T.orange, accion: "Acción inmediata — alto riesgo de cesión" };
  return { key: "rojo", label: "CRÍTICO 90+", color: T.red, accion: "Cobranza formal urgente" };
};
// Rango del reporte Hy Cite (0-30/31-60/61-90/91+/colección) → manda sobre los días calculados
const RANGO_A_DIAS = { "0-30": 15, "31-60": 45, "61-90": 75, "91+": 120, "coleccion": 150 };
// Convierte CUALQUIER forma del atraso a nuestro código de rango: acepta el código
// exacto ("61-90"), el texto del badge de Hy Cite ("De 61 a 90 días de atraso"),
// inglés ("Over 90"), colección/charge back, "al día", etc. Nunca inventa.
function normalizarRangoHC(txt){
  const t = String(txt||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
  if(!t.trim()) return "";
  if(/coleccion|charge\s*back|cargo\s*de\s*vuelta/.test(t)) return "coleccion";
  if(/91|over\s*90|mas\s*de\s*90|90\s*\+|\+\s*90/.test(t)) return "91+";
  if(/61/.test(t) && /90/.test(t)) return "61-90";
  if(/31/.test(t) && /60/.test(t)) return "31-60";
  if(/al\s*dia|current|corriente/.test(t)) return "0-30";
  if(/\b0\b.*30|1\s*a\s*30|0-30/.test(t)) return "0-30";
  return "";
}
// A prueba de balas: busca el rango de atraso en CUALQUIER campo del registro que
// devuelva la IA — no importa si lo puso en "rango", "estado", "status" o en un
// campo con nombre inesperado. Primero los campos conocidos (más fiables), luego
// un barrido total de todos los valores de texto. Así el atraso NUNCA se pierde
// por culpa del nombre del campo.
function rangoDeRegistro(r){
  if(!r || typeof r !== "object") return "";
  const conocidos = ["rango","estadoTexto","estado","status","situacion","dias_atraso","diasAtraso","atrasoDias","dias","aging","bucket"];
  for(const k of conocidos){ const v = normalizarRangoHC(r[k]); if(v) return v; }
  // barrido: cualquier valor de texto del objeto que mencione el atraso
  for(const val of Object.values(r)){
    if(typeof val === "string"){ const v = normalizarRangoHC(val); if(v) return v; }
  }
  return "";
}
const semDeCliente = (c, th) => {
  // 1) El RANGO del reporte Hy Cite manda (0-30/31-60/61-90/91+/colección).
  // 2) Sin rango: los días desde el último pago registrado.
  // 3) Sin rango NI fecha válida → NO se marca crítico: queda "al corriente /
  //    sin datos" para que la lista de CRÍTICOS solo tenga atrasados REALES.
  const d = daysSince(c.ultimoPago);
  const base = (c.rango && RANGO_A_DIAS[c.rango] !== undefined)
    ? semaforoDe(RANGO_A_DIAS[c.rango], th)
    : (Number.isFinite(d) ? semaforoDe(d, th) : { ...semaforoDe(0, th), sinDatos: true });
  if(c.rango === "coleccion") return { ...base, label: "COLECCIÓN (cargo de vuelta)", coleccion: true };
  // "0-30" es un ATRASO (1 cuota) — no es lo mismo que estar al corriente.
  if(c.rango === "0-30") return { ...base, label: "0-30 DÍAS", r030: true };
  return base;
};
const mesesVencidos = c => c.pagoMensual > 0 ? Math.min(24, Math.floor(daysSince(c.ultimoPago) / 30)) : 0;
const montoVencido = c => Math.min(c.saldo, mesesVencidos(c) * c.pagoMensual);
const pagoEsteMes = (c, mesKey) => (c.historial || []).some(h => h.tipo === "pago" && h.fecha.startsWith(mesKey));
const enRiesgoCesion = (c, mesKey) => mesesVencidos(c) >= 2 && !pagoEsteMes(c, mesKey);
const scoreDe = (c, th) => {
  const d = daysSince(c.ultimoPago);
  const sDias = Math.min(90, d);
  const sSaldo = Math.min(60, Math.round(c.saldo / 1500 * 60));
  const fallidos = (c.historial || []).filter(h => h.tipo === "promesa_rota").length;
  const sHist = Math.min(30, fallidos * 10 + (d > th.naranja ? 10 : 0));
  const sCesion = mesesVencidos(c) >= 2 ? 30 : 0;
  return sDias + sSaldo + sHist + sCesion;
};

/* ── Seed data ── */
const PLANTILLAS_DEFAULT = {
  verde: "Hola {nombre} 👋 Le saluda {usuario} de Royal Prestige. Le recuerdo con cariño que su próximo pago de {cuota} está por vencer. ¡Gracias por mantener su cuenta al día! 🙌\n\n💳 Si gusta, solicite por este mismo medio su LINK DE PAGO para pagar directo con su tarjeta, o indíquenos un horario y le llamamos para procesar su pago por teléfono.",
  amarillo: "Hola {nombre}, le saluda {usuario} de Royal Prestige. Su cuenta tiene un saldo de {saldo} y {dias} días sin registrar pago. ¿Le funciona ponerse al corriente esta semana con {cuota}? Puede pagar por {pago}. Quedo al pendiente 📲\n\n💳 Si gusta, solicite por este mismo medio su LINK DE PAGO para pagar directo con su tarjeta, o indíquenos un horario y le llamamos para procesar su pago por teléfono.",
  naranja: "{nombre}, buen día. Le escribe {usuario} de Royal Prestige. Su cuenta presenta {dias} días sin pago y un saldo de {saldo}. Es importante regularizarla esta semana para evitar cargos por demora. ¿Podemos acordar un abono hoy? Pague por {pago}.\n\n💳 Si gusta, solicite por este mismo medio su LINK DE PAGO para pagar directo con su tarjeta, o indíquenos un horario y le llamamos para procesar su pago por teléfono.",
  rojo: "{nombre}, le contacta {usuario}, distribuidor autorizado de Royal Prestige. Su cuenta tiene {dias} días de atraso con saldo de {saldo} y está en riesgo de pasar a cobranza formal. Necesito que nos comuniquemos HOY para establecer un plan. Puede abonar por {pago}.\n\n💳 Si gusta, solicite por este mismo medio su LINK DE PAGO para pagar directo con su tarjeta, o indíquenos un horario y le llamamos para procesar su pago por teléfono."
};
const renderPlantilla = (tpl, c, cfg) => {
  const formas = [cfg.zelle && `Zelle ${cfg.zelle}${cfg.zelleTitular ? " (" + cfg.zelleTitular + ")" : ""}`, cfg.cashapp && `Cash App ${cfg.cashapp}${cfg.cashappTitular ? " (" + cfg.cashappTitular + ")" : ""}`].filter(Boolean).join(" o ") || "Zelle o Cash App";
  return (tpl || "").replace(/{nombre}/g, c.nombre.split(" ")[0]).replace(/{nombreCompleto}/g, c.nombre).replace(/{saldo}/g, fmt(c.saldo)).replace(/{cuota}/g, fmt(c.pagoMensual)).replace(/{dias}/g, String(daysSince(c.ultimoPago))).replace(/{usuario}/g, cfg.usuario || "").replace(/{pago}/g, formas);
};
const plantillaLocal = (c, sem, cfgOuser) => {
  const cfg = typeof cfgOuser === "string" ? {
    usuario: cfgOuser,
    plantillas: PLANTILLAS_DEFAULT
  } : cfgOuser;
  const tpls = cfg && cfg.plantillas || PLANTILLAS_DEFAULT;
  return renderPlantilla(tpls[sem.key] || PLANTILLAS_DEFAULT[sem.key], c, cfg || {
    usuario: ""
  });
};
const MESES_ES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const mesKeyHoy = () => todayISO().slice(0, 7);
const nombreMes = ym => MESES_ES[+ym.split("-")[1] - 1] + " " + ym.split("-")[0];
const diasRestantesMes = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate() + 1;
};
const CARTERAS = {
  dist: {
    id: "dist",
    nombre: "DISTRIBUCIÓN",
    corto: "DIST",
    desc: "Clientes activos dentro de Royal Prestige / Hy Cite"
  },
  fin: {
    id: "fin",
    nombre: "MI FINANCIERA",
    corto: "FINANCIERA",
    desc: "Clientes en colección o financiados directamente por mí"
  }
};
const genFactura = (c, cfg) => {
  const dias = daysSince(c.ultimoPago);
  return `🧾 ESTADO DE CUENTA — ROYAL PRESTIGE
IMPACT ENTERPRISES · Distribuidor Autorizado FLOT0030
━━━━━━━━━━━━━━━━━━━━━━
Fecha: ${todayISO()}
Cliente: ${c.nombre}${c.nroCuenta ? " · Cta " + c.nroCuenta : ""}
Cartera: ${CARTERAS[c.cartera || "dist"].nombre}
━━━━━━━━━━━━━━━━━━━━━━
Saldo pendiente: ${fmt(c.saldo)}
Pago mensual: ${fmt(c.pagoMensual)}
Días desde su último pago: ${dias}
${dias > 30 ? "⚠ Su cuenta puede generar intereses y cargos por demora.\n" : ""}━━━━━━━━━━━━━━━━━━━━━━
FORMAS DE PAGO
${cfg.zelle ? "• Zelle: " + cfg.zelle + (cfg.zelleTitular ? " — " + cfg.zelleTitular : "") + "\n" : ""}${cfg.cashapp ? "• Cash App: " + cfg.cashapp + (cfg.cashappTitular ? " — " + cfg.cashappTitular : "") + "\n" : ""}• Efectivo o tarjeta en su visita

Para realizar su pago o acordar un plan:
${cfg.usuario || ""}${cfg.telDistribuidor ? " · " + cfg.telDistribuidor : ""}
Gracias por su preferencia 🙏`;
};
const waLink = (tel, msg) => `https://wa.me/${cleanPhone(tel)}?text=${encodeURIComponent(msg)}`;
const smsLink = (tel, msg) => `sms:${cleanPhone(tel)}?&body=${encodeURIComponent(msg)}`;
const csvDownload = (nombre, filas) => {
  const csv = filas.map(r => r.map(x => `"${String(x ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF" + csv], {
    type: "text/csv;charset=utf-8"
  }));
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(a.href);
};
// Genera un reporte imprimible: en iPhone, desde el diálogo de imprimir se
// comparte/guarda como PDF (pellizca la vista previa o usa el botón compartir).
const pdfPrint = (titulo, cols, filas) => {
  const esc = t => String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(titulo)}</title><style>
    body{font-family:-apple-system,'Segoe UI',Arial,sans-serif;margin:24px;color:#1f2d3d}
    h1{font-size:18px;margin:0 0 2px}.sub{font-size:11px;color:#64748b;margin-bottom:14px}
    table{width:100%;border-collapse:collapse;font-size:10px}
    th{background:#eef2f7;text-align:left;padding:6px 7px;border:1px solid #d6dee8}
    td{padding:5px 7px;border:1px solid #e2e8f0}
    tr:nth-child(even) td{background:#f8fafc}
    @media print{body{margin:8mm}}
  </style></head><body>
  <h1>${esc(titulo)}</h1><div class="sub">Impact Enterprises · Cobranza · ${todayISO()} · ${filas.length} registro(s)</div>
  <table><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead>
  <tbody>${filas.map(f => `<tr>${f.map(v => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>
  <script>window.onload=function(){setTimeout(function(){window.print();},350);};</scr` + `ipt></body></html>`;
  const w = window.open("", "_blank");
  if (!w) { alert("Permite ventanas emergentes en Safari para generar el PDF"); return; }
  w.document.write(html);
  w.document.close();
};
async function generarMensajeIA(c, sem, cfg) {
  try {
    const res = await fetch("/api/anthropic", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `Eres asistente de cobranza de Royal Prestige para el distribuidor ${cfg.usuario}. Genera UN mensaje de WhatsApp en español para este cliente. Responde SOLO con el texto del mensaje, sin comillas ni preámbulo.\n\nCliente: ${c.nombre} (${c.ciudad})\nSaldo: ${fmt(c.saldo)} | Pago mensual: ${fmt(c.pagoMensual)}\nDías sin pagar: ${daysSince(c.ultimoPago)} | Nivel: ${sem.label}\n\nMáximo 90 palabras. Incluye opciones de pago Zelle/Cash App.`
        }]
      })
    });
    if (!res.ok) throw new Error("API " + res.status);
    const data = await res.json();
    const txt = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    if (!txt) throw new Error("vacío");
    return {
      texto: txt,
      fuente: "IA"
    };
  } catch {
    return {
      texto: plantillaLocal(c, sem, cfg),
      fuente: "Plantilla local"
    };
  }
}

/* ── localStorage hook ── */
const Card = ({
  children,
  style,
  glow,
  onClick
}) => <div onClick={onClick} style={{
  background: T.panel,
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  padding: 20,
  boxShadow: glow ? T.glowLg : T.glow,
  animation: "fadeUp .4s ease both",
  ...style
}}>{children}</div>;
const Btn = ({
  children,
  onClick,
  variant = "primary",
  style,
  disabled,
  title
}) => {
  const base = {
    fontFamily: T.mono,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: 0.3,
    padding: "10px 16px",
    borderRadius: 7,
    cursor: disabled ? "not-allowed" : "pointer",
    border: "1px solid",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    transition: "all .15s",
    opacity: disabled ? 0.4 : 1
  };
  const v = {
    primary: {
      background: T.blueMid,
      color: "#fff",
      borderColor: T.blueMid,
      boxShadow: T.glow
    },
    ghost: {
      background: "#fff",
      color: T.blueMid,
      borderColor: T.borderHi
    },
    danger: {
      background: "transparent",
      color: T.red,
      borderColor: T.red
    },
    dim: {
      background: T.panel2,
      color: T.mut,
      borderColor: T.border
    }
  };
  return <button title={title} disabled={disabled} onClick={onClick} style={{
    ...base,
    ...v[variant],
    ...style
  }}>{children}</button>;
};
const Input = ({
  label,
  error,
  ...p
}) => <label style={{
  display: "block",
  marginBottom: 12
}}>
    <span style={{
    fontSize: 11,
    color: T.blueMid,
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: "uppercase"
  }}>{label}</span>
    <input {...p} style={{
    width: "100%",
    boxSizing: "border-box",
    marginTop: 4,
    background: "#fff",
    border: `2px solid ${error ? T.red : T.border}`,
    borderRadius: 7,
    color: T.text,
    fontFamily: T.mono,
    fontSize: 14,
    fontWeight: 600,
    padding: "10px 12px",
    outline: "none",
    ...p.style
  }} />
    {error && <span style={{
    fontSize: 10,
    color: T.red
  }}>{error}</span>}
  </label>;
const Badge = ({
  sem
}) => <span style={{
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 1,
  color: sem.color,
  background: sem.color + "14",
  border: `1.5px solid ${sem.color}`,
  borderRadius: 12,
  padding: "3px 10px",
  whiteSpace: "nowrap"
}}>{sem.label}</span>;
const Modal = ({
  title,
  onClose,
  children,
  wide
}) => <div onClick={onClose} style={{
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.8)",
  zIndex: 100,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16
}}>
    <div onClick={e => e.stopPropagation()} style={{
    background: T.panel,
    border: `1px solid ${T.borderHi}`,
    borderRadius: 10,
    width: "100%",
    maxWidth: wide ? 720 : 460,
    maxHeight: "90vh",
    overflowY: "auto",
    boxShadow: T.glowLg
  }}>
      <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "14px 18px",
      borderBottom: `1px solid ${T.border}`
    }}>
        <span style={{
        fontFamily: T.serif,
        fontSize: 17,
        fontWeight: 700,
        color: T.blue
      }}>{title}</span>
        <button onClick={onClose} aria-label="Cerrar" style={{
        background: "none",
        border: "none",
        color: T.mut,
        cursor: "pointer"
      }}><X size={16} /></button>
      </div>
      <div style={{
      padding: 18
    }}>{children}</div>
    </div>
  </div>;
const H1 = ({
  children
}) => <h1 style={{
  fontFamily: T.serif,
  fontSize: 24,
  fontWeight: 700,
  color: T.blue,
  margin: "0 0 18px"
}}>{children}</h1>;
const SubT = ({
  children,
  style
}) => <div style={{
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: T.blueMid,
  marginBottom: 12,
  ...style
}}>{children}</div>;

/* ── Toasts ── */
let toastFn = null;
const toast = (msg, type = "ok") => toastFn && toastFn(msg, type);
const ToastHost = () => {
  const [items, setItems] = useState([]);
  useEffect(() => {
    toastFn = (msg, type = "ok") => {
      const id = Date.now() + Math.random();
      setItems(x => [...x, {
        id,
        msg,
        type
      }]);
      setTimeout(() => setItems(x => x.filter(i => i.id !== id)), 3500);
    };
    return () => {
      toastFn = null;
    };
  }, []);
  return <div style={{
    position: "fixed",
    bottom: 90,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 200,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    width: "min(92vw, 380px)"
  }}>
      {items.map(i => <div key={i.id} style={{
      background: "#fff",
      border: `1px solid ${i.type === "err" ? T.red : T.green}`,
      color: i.type === "err" ? T.red : T.green,
      borderRadius: 7,
      padding: "10px 14px",
      fontFamily: T.mono,
      fontSize: 12,
      fontWeight: 600,
      boxShadow: T.glowLg,
      display: "flex",
      gap: 8,
      alignItems: "center"
    }}>
          {i.type === "err" ? <XCircle size={14} /> : <CheckCircle2 size={14} />} {i.msg}
        </div>)}
    </div>;
};

/* ── CarteraChips ── */
const CarteraChips = ({
  value,
  onChange,
  conTodas
}) => <div style={{
  display: "flex",
  gap: 7,
  marginBottom: 12,
  flexWrap: "wrap"
}}>
    {(conTodas ? [["todas", "Todas"]] : []).concat([["dist", "Distribución"], ["fin", "Mi Financiera"]]).map(([k, n]) => <button key={k} onClick={() => onChange(k)} style={{
    background: value === k ? T.blueMid : T.bg,
    border: `1.5px solid ${value === k ? T.blueMid : T.border}`,
    color: value === k ? "#fff" : "#5a5a5a",
    padding: "6px 14px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 20,
    cursor: "pointer",
    fontFamily: T.mono,
    transition: "all .2s"
  }}>{n}</button>)}
  </div>;

/* ── ConfigMes ── */
const ConfigMes = ({
  mesKey,
  mesCfg,
  setMeses,
  onClose
}) => {
  const [f, setF] = useState({
    dist: mesCfg?.dist ?? "",
    fin: mesCfg?.fin ?? "",
    metaPct: mesCfg?.metaPct ?? 8
  });
  const [err, setErr] = useState("");
  const guardar = () => {
    if (isNaN(+f.dist) || +f.dist < 0 || f.dist === "" || isNaN(+f.fin) || +f.fin < 0 || f.fin === "") return setErr("Captura montos válidos en ambas carteras");
    if (isNaN(+f.metaPct) || +f.metaPct <= 0 || +f.metaPct > 100) return setErr("La meta debe ser entre 1 y 100");
    setMeses(m => ({
      ...m,
      [mesKey]: {
        dist: +f.dist,
        fin: +f.fin,
        metaPct: +f.metaPct
      }
    }));
    toast(`Cartera de ${nombreMes(mesKey)} actualizada`);
    onClose();
  };
  return <Modal title={"CARTERA DE " + nombreMes(mesKey).toUpperCase()} onClose={onClose}>
      <div style={{
      fontSize: 11,
      color: T.mut,
      marginBottom: 14,
      lineHeight: 1.6
    }}>Captura el monto real con el que arranca cada cartera este mes.</div>
      <Input label={"Cartera Distribución ($)"} type="number" value={f.dist} onChange={e => {
      setF({
        ...f,
        dist: e.target.value
      });
      setErr("");
    }} placeholder="200000" />
      <Input label={"Cartera Mi Financiera ($)"} type="number" value={f.fin} onChange={e => {
      setF({
        ...f,
        fin: e.target.value
      });
      setErr("");
    }} placeholder="35000" />
      <Input label="Meta del mes (% de la cartera)" type="number" value={f.metaPct} onChange={e => {
      setF({
        ...f,
        metaPct: e.target.value
      });
      setErr("");
    }} />
      {err && <div style={{
      color: T.red,
      fontSize: 11,
      marginBottom: 10
    }}>{err}</div>}
      <Btn onClick={guardar} style={{
      width: "100%",
      justifyContent: "center"
    }}><CheckCircle2 size={14} /> GUARDAR MES</Btn>
    </Modal>;
};

/* ── QuickPago ── */
/* ── BuscadorCliente: buscar por nombre o número de cuenta ── */
const BuscadorCliente = ({ clientes, value, onChange, compact, placeholder }) => {
  const [q, setQ] = useState("");
  const sel = clientes.find(c => String(c.id) === String(value));
  const t = q.toLowerCase().trim();
  const matches = t ? clientes.filter(c => c.nombre.toLowerCase().includes(t) || String(c.nroCuenta || "").includes(t)).slice(0, 8) : [];
  const fz = compact ? 11 : 13;
  if (sel) return <div style={{ display: "flex", alignItems: "center", gap: 6, background: T.bluePale, border: `1.5px solid ${T.blueMid}`, borderRadius: 7, padding: compact ? "5px 8px" : "9px 12px" }}>
    <span style={{ flex: 1, fontFamily: T.mono, fontSize: fz, fontWeight: 700, color: T.blue, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sel.nombre}{sel.nroCuenta ? ` · cta ${sel.nroCuenta}` : ""} · {fmt(sel.saldo)}</span>
    <button onClick={() => { onChange(""); setQ(""); }} title="Quitar" style={{ background: "none", border: "none", cursor: "pointer", color: T.mut, fontSize: fz + 3, fontWeight: 700, padding: 0, lineHeight: 1 }}><Ico e="✕" /></button>
  </div>;
  return <div style={{ position: "relative" }}>
    <input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder || "Buscar por nombre o cuenta…"} inputMode="search" style={{
      width: "100%", boxSizing: "border-box", background: "#fff", border: `1.5px solid ${t ? T.blueMid : T.border}`,
      borderRadius: 7, padding: compact ? "6px 8px" : "10px 12px", fontFamily: T.mono, fontSize: fz, color: T.text, outline: "none"
    }} />
    {matches.length > 0 && <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, background: "#fff", border: `1.5px solid ${T.blueMid}`, borderRadius: 7, marginTop: 3, maxHeight: 200, overflowY: "auto", boxShadow: T.glowLg }}>
      {matches.map(c => <button key={c.id} onClick={() => { onChange(c.id); setQ(""); }} style={{
        display: "block", width: "100%", boxSizing: "border-box", textAlign: "left", background: "none", border: "none", borderBottom: `1px solid ${T.bg}`,
        padding: compact ? "7px 9px" : "9px 12px", cursor: "pointer", fontFamily: T.mono, fontSize: fz, color: T.text
      }}><b>{c.nombre}</b>{c.nroCuenta ? ` · cta ${c.nroCuenta}` : ""} · <span style={{ color: T.blueMid, fontWeight: 700 }}>{fmt(c.saldo)}</span></button>)}
    </div>}
    {t && !matches.length && <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, background: "#fff", border: `1px solid ${T.border}`, borderRadius: 7, marginTop: 3, padding: "8px 12px", fontFamily: T.mono, fontSize: 11, color: T.mut }}>Sin coincidencias</div>}
  </div>;
};
const QuickPago = ({
  clientes,
  onPago,
  onClose
}) => {
  const [id, setId] = useState("");
  const sel = clientes.find(c => String(c.id) === String(id));
  const [monto, setMonto] = useState(sel?.pagoMensual || "");
  const [metodo, setMetodo] = useState("Zelle");
  const [err, setErr] = useState("");
  const ok = () => {
    const m = +monto;
    if (!sel) return setErr("Selecciona un cliente");
    if (isNaN(m) || m <= 0) return setErr("Ingresa un monto mayor a cero");
    onPago(sel.id, m, metodo);
    onClose();
  };
  return <Modal title="REGISTRAR PAGO DEL DÍA" onClose={onClose}>
      <label style={{
      display: "block",
      marginBottom: 12
    }}>
        <span style={{
        fontSize: 11,
        color: T.blueMid,
        fontWeight: 700,
        letterSpacing: 0.6,
        textTransform: "uppercase"
      }}>Cliente</span>
        <div style={{
        marginTop: 4
      }}>
          <BuscadorCliente clientes={clientes} value={id} onChange={nid => {
          setId(nid);
          const s = clientes.find(c => String(c.id) === String(nid));
          setMonto(s?.pagoMensual || "");
          setErr("");
        }} />
        </div>
      </label>
      <Input label="Monto ($)" type="number" value={monto} onChange={e => {
      setMonto(e.target.value);
      setErr("");
    }} error={err} />
      <SubT>MÉTODO</SubT>
      <div style={{
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 8,
      marginBottom: 16
    }}>
        {["Zelle", "Cash App", "Efectivo", "Tarjeta"].map(m => <button key={m} onClick={() => setMetodo(m)} style={{
        padding: 10,
        background: metodo === m ? T.bluePale : "#fff",
        border: `2px solid ${metodo === m ? T.blueMid : T.border}`,
        borderRadius: 7,
        color: metodo === m ? T.blueMid : T.mut,
        fontFamily: T.mono,
        fontSize: 11,
        fontWeight: 700,
        cursor: "pointer"
      }}>{m.toUpperCase()}</button>)}
      </div>
      <Btn onClick={ok} style={{
      width: "100%",
      justifyContent: "center"
    }}><DollarSign size={14} /> CONFIRMAR PAGO</Btn>
    </Modal>;
};

/* ── FacturaModal ── */
const FacturaModal = ({
  c,
  cfg,
  onClose
}) => {
  const [txt, setTxt] = useState(genFactura(c, cfg));
  return <Modal title={"FACTURA DE COBRO · " + c.nombre.split(" ")[0].toUpperCase()} onClose={onClose} wide>
      <textarea value={txt} onChange={e => setTxt(e.target.value)} rows={15} style={{
      width: "100%",
      boxSizing: "border-box",
      background: "#fff",
      border: `2px solid ${T.border}`,
      borderRadius: 7,
      color: T.text,
      fontFamily: T.mono,
      fontSize: 12.5,
      padding: 14,
      outline: "none",
      resize: "vertical",
      lineHeight: 1.55
    }} />
      <div style={{
      display: "flex",
      gap: 8,
      flexWrap: "wrap",
      marginTop: 12
    }}>
        <a href={waLink(c.tel, txt)} target="_blank" rel="noreferrer" style={{
        textDecoration: "none"
      }}><Btn><MessageCircle size={13} /> WHATSAPP</Btn></a>
        <a href={`mailto:${c.email}?subject=${encodeURIComponent("Estado de cuenta — Royal Prestige · " + c.nombre)}&body=${encodeURIComponent(txt)}`} style={{
        textDecoration: "none"
      }}><Btn variant="ghost"><Mail size={13} /> EMAIL</Btn></a>
        <a href={`tel:${cleanPhone(c.tel)}`} style={{
        textDecoration: "none"
      }}><Btn variant="ghost"><Phone size={13} /> LLAMAR</Btn></a>
        <Btn variant="ghost" onClick={() => {
        navigator.clipboard?.writeText(txt);
        toast("Factura copiada");
      }}>COPIAR</Btn>
      </div>
    </Modal>;
};

/* ── PromesaModal ── */
const PromesaModal = ({
  c,
  onSave,
  onClose
}) => {
  const [fecha, setFecha] = useState(todayISO());
  const [hora, setHora] = useState("15:00");
  const [monto, setMonto] = useState(c.pagoMensual);
  const [err, setErr] = useState("");
  const ok = () => {
    if (!fecha || fecha < todayISO()) return setErr("La fecha debe ser hoy o futura");
    if (monto !== "" && (isNaN(+monto) || +monto <= 0)) return setErr("Monto inválido");
    onSave(fecha, hora || "12:00", monto === "" ? null : +monto);
    onClose();
  };
  return <Modal title={"🤝 PROMESA DE PAGO · " + c.nombre.split(" ")[0].toUpperCase()} onClose={onClose}>
      <div style={{
      fontSize: 11,
      color: T.mut,
      marginBottom: 14
    }}>Registra cuándo se comprometió a pagar.</div>
      <div style={{
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 10
    }}>
        <Input label="Fecha prometida" type="date" value={fecha} onChange={e => {
        setFecha(e.target.value);
        setErr("");
      }} />
        <Input label="Hora" type="time" value={hora} onChange={e => setHora(e.target.value)} />
      </div>
      <Input label="Monto prometido ($, opcional)" type="number" value={monto} onChange={e => {
      setMonto(e.target.value);
      setErr("");
    }} />
      {err && <div style={{
      color: T.red,
      fontSize: 11,
      marginBottom: 10
    }}>{err}</div>}
      <Btn onClick={ok} style={{
      width: "100%",
      justifyContent: "center"
    }}><CheckCircle2 size={14} /> GUARDAR PROMESA</Btn>
    </Modal>;
};

/* ── LlamarModal ── */
const LlamarModal = ({
  tel,
  cfg,
  onClose
}) => {
  const num = cleanPhone(tel);
  const opciones = [{
    label: "Teléfono / celular",
    desc: "App de llamadas normal",
    href: `tel:${num}`,
    icon: Phone,
    ext: false
  }, cfg.crmTelemarketingUrl ? {
    label: "CRM Telemarketing",
    desc: "Marcar desde tu CRM",
    href: cfg.crmTelemarketingUrl.replace("{tel}", num).replace("{tel10}", num.replace(/^1/, "")),
    icon: Target,
    ext: true
  } : null, {
    label: "WhatsApp (llamada)",
    desc: "Abre el chat para llamar",
    href: `https://wa.me/${num}`,
    icon: MessageCircle,
    ext: true
  }].filter(Boolean);
  return <Modal title={"LLAMAR · " + tel} onClose={onClose}>
      <div style={{
      fontSize: 11,
      color: T.mut,
      marginBottom: 14
    }}>Elige por dónde quieres llamar:</div>
      {opciones.map((o, i) => <a key={i} href={o.href} target={o.ext ? "_blank" : undefined} rel="noreferrer" onClick={() => setTimeout(onClose, 300)} style={{
      textDecoration: "none",
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "13px 14px",
      marginBottom: 8,
      background: "#fff",
      border: `2px solid ${T.border}`,
      borderRadius: 8,
      cursor: "pointer"
    }}>
          <o.icon size={18} color={T.blueMid} />
          <div style={{
        flex: 1
      }}>
            <div style={{
          fontSize: 13,
          fontWeight: 700,
          color: T.text
        }}>{o.label}</div>
            <div style={{
          fontSize: 10,
          color: T.mut
        }}>{o.desc}</div>
          </div>
          <ChevronRight size={15} color={T.mut} />
        </a>)}
    </Modal>;
};

/* ── IA compartida: leer foto/PDF y devolver JSON ── */
const leerConIA = (file, prompt, maxTokens = 4096) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = async () => {
    try {
      const b64 = String(r.result).split(",")[1];
      const esPDF = file.type === "application/pdf";
      const bloque = esPDF
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
        : { type: "image", source: { type: "base64", media_type: file.type || "image/jpeg", data: b64 } };
      const res = await fetch("/api/anthropic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens,
          messages: [{ role: "user", content: [bloque, { type: "text", text: prompt }] }] })
      });
      if (!res.ok) throw new Error("Servidor " + res.status);
      const data = await res.json();
      const txt = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").replace(/```json|```/g, "").trim();
      resolve(JSON.parse(txt));
    } catch (e) { reject(e); }
  };
  r.onerror = () => reject(new Error("No se pudo leer el archivo"));
  r.readAsDataURL(file);
});
const BotonSubirIA = ({ leyendo, onFile, texto }) => {
  const ref = useRef(null);
  return <>
    <button onClick={() => ref.current?.click()} disabled={leyendo} style={{
      width: "100%", boxSizing: "border-box", background: T.bluePale, border: `2px dashed ${T.blueMid}`,
      borderRadius: 7, padding: 26, cursor: leyendo ? "wait" : "pointer", fontFamily: T.mono,
      color: T.blueMid, fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center",
      justifyContent: "center", gap: 8, animation: leyendo ? "pulse 1s infinite" : "none"
    }}><Camera size={16} /> {leyendo ? "LEYENDO CON IA…" : texto}</button>
    <input ref={ref} type="file" accept="image/*,application/pdf" style={{ display: "none" }}
      onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
  </>;
};

/* ── ImportReporteFin: Resumen de métricas Hy Cite (cartera + atrasos + niveles) ── */
const ImportReporteFin = ({ onGuardar, onClose }) => {
  const [leyendo, setLeyendo] = useState(false);
  const [snap, setSnap] = useState(null);
  const [fecha, setFecha] = useState(todayISO());
  const PROMPT = 'Esta imagen o documento es un "Resumen de métricas" de cuentas por cobrar de Hy Cite / Royal Prestige. Tiene una tabla con columnas: Nivel, Cuentas por cobrar, (0-30), (31-60), (61-90), (Over 90) y una fila TOTAL. Devuelve SOLO JSON válido, sin texto ni backticks: {"niveles":[{"nivel":1,"cxc":0,"d0":0,"d31":0,"d61":0,"d90":0}],"total":{"cxc":0,"d0":0,"d31":0,"d61":0,"d90":0},"cesion":{"cuentas":0,"monto":0}}. Montos como números sin $ ni comas. cxc=Cuentas por cobrar, d0=(0-30), d31=(31-60), d61=(61-90), d90=(Over 90). Incluye todos los niveles que aparezcan, en orden. Si el reporte menciona cuentas en cesión (cedidas o por ceder) pon su cantidad en cesion.cuentas y su monto en cesion.monto; si no aparece, deja ambos en 0.';
  const leer = async (f) => {
    setLeyendo(true);
    try {
      const j = await leerConIA(f, PROMPT);
      const num = v => +(+v || 0).toFixed(2);
      const tot = j.total || {};
      const niveles = (j.niveles || []).map(n => ({ nivel: +n.nivel || 0, cxc: num(n.cxc), d0: num(n.d0), d31: num(n.d31), d61: num(n.d61), d90: num(n.d90) }));
      const total = { cxc: num(tot.cxc), d0: num(tot.d0), d31: num(tot.d31), d61: num(tot.d61), d90: num(tot.d90) };
      if (!(total.cxc > 0)) throw new Error("no encontré el total de Cuentas por cobrar");
      const ces = j.cesion || {};
      setSnap({ total, niveles, cesion: { cuentas: Math.max(0, Math.round(+ces.cuentas || 0)), monto: num(ces.monto) } });
    } catch (e) { toast("No pude leer el reporte: " + (e.message || e), "err"); }
    setLeyendo(false);
  };
  const sumaNiv = snap ? snap.niveles.reduce((s, n) => s + n.cxc, 0) : 0;
  const difiere = snap && snap.niveles.length > 0 && Math.abs(sumaNiv - snap.total.cxc) > 1;
  const atr = snap ? snap.total.d0 + snap.total.d31 + snap.total.d61 + snap.total.d90 : 0;
  const celda = { padding: "5px 8px", fontSize: 11, textAlign: "right", borderBottom: `1px solid ${T.bg}` };
  return <Modal title="IMPORTAR REPORTE FINANCIERO" onClose={onClose} wide>
    {!snap ? <>
      <div style={{ fontSize: 11, color: T.mut, marginBottom: 12, lineHeight: 1.6 }}>
        Sube la foto o PDF del <b>Resumen de métricas</b> de Hy Cite. La IA extrae la cartera exacta de Distribución, los atrasos por rango y el desglose por nivel. El <b>primer reporte del mes</b> fija automáticamente la cartera inicial.
      </div>
      <BotonSubirIA leyendo={leyendo} onFile={leer} texto="SUBIR FOTO O PDF DEL REPORTE" />
    </> : <>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.mut, marginBottom: 4 }}>FECHA DEL REPORTE</div>
          <input type="date" value={fecha} onChange={e => setFecha(e.target.value)} style={{
            width: "100%", boxSizing: "border-box", background: "#fff", border: `2px solid ${T.border}`,
            borderRadius: 7, padding: "8px 10px", fontFamily: T.mono, fontSize: 13, color: T.text, outline: "none" }} />
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.mut }}>CARTERA (CxC)</div>
          <div style={{ fontFamily: T.serif, fontSize: 22, fontWeight: 700, color: T.blue }}>{fmt(snap.total.cxc)}</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginBottom: 10 }}>
        {[["0-30", snap.total.d0, T.yellow], ["31-60", snap.total.d31, T.orange], ["61-90", snap.total.d61, T.red], ["+90", snap.total.d90, "#7f1d1d"]].map(([l, v, c]) =>
          <div key={l} style={{ background: T.bg, border: `1px solid ${T.border}`, borderLeft: `3px solid ${c}`, borderRadius: 7, padding: "7px 9px" }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: T.mut }}>ATRASO {l}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{fmt(v)}</div>
          </div>)}
      </div>
      <div style={{ fontSize: 11, color: T.mut, marginBottom: 10 }}>Atrasos totales: <b style={{ color: T.red }}>{fmt(atr)}</b> · Mora: <b style={{ color: T.red }}>{snap.total.cxc > 0 ? (atr / snap.total.cxc * 100).toFixed(1) : 0}%</b></div>
      {snap.niveles.length > 0 && <div style={{ maxHeight: 180, overflowY: "auto", border: `1px solid ${T.border}`, borderRadius: 7, marginBottom: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: T.mono }}>
          <thead><tr>{["Nivel", "CxC", "0-30", "31-60", "61-90", "+90"].map(h => <th key={h} style={{ ...celda, textAlign: h === "Nivel" ? "left" : "right", background: T.bluePale, color: T.blue, fontWeight: 700, position: "sticky", top: 0 }}>{h}</th>)}</tr></thead>
          <tbody>{snap.niveles.map(n => <tr key={n.nivel}>
            <td style={{ ...celda, textAlign: "left", fontWeight: 700 }}>{n.nivel}</td>
            <td style={celda}>{fmt(n.cxc)}</td><td style={celda}>{fmt(n.d0)}</td><td style={celda}>{fmt(n.d31)}</td><td style={celda}>{fmt(n.d61)}</td><td style={celda}>{fmt(n.d90)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {difiere && <div style={{ fontSize: 10, color: T.orange, marginBottom: 10 }}><Ico e="⚠" className="mr-1.5" />La suma de niveles ({fmt(sumaNiv)}) difiere del TOTAL leído — se usará la fila TOTAL del reporte.</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" onClick={() => setSnap(null)} style={{ flex: 1, justifyContent: "center" }}>VOLVER A LEER</Btn>
        <Btn onClick={() => { if (!fecha) return toast("Selecciona la fecha del reporte", "err"); onGuardar({ fecha, total: snap.total, niveles: snap.niveles }); onClose(); }} style={{ flex: 2, justifyContent: "center" }}><CheckCircle2 size={14} /> GUARDAR REPORTE</Btn>
      </div>
    </>}
  </Modal>;
};

/* ── ImportPagosDia: reporte de pagos diarios con IA → registra pago por cliente ── */
const ImportPagosDia = ({ clientes, onPago, onPagoExterno, onClose }) => {
  const [leyendo, setLeyendo] = useState(false);
  const [filas, setFilas] = useState(null);
  const PROMPT = 'Este documento o imagen es un reporte de pagos diarios de clientes de Royal Prestige / Hy Cite (Recibo de Pagos). Extrae cada pago que aparezca. Devuelve SOLO un arreglo JSON válido, sin texto ni backticks: [{"cuenta":"número de cuenta solo dígitos","nombre":"nombre del cliente","monto":número,"fecha":"YYYY-MM-DD"}]. Montos como números sin $ ni comas. fecha = la FECHA DE PAGO de esa fila convertida a formato YYYY-MM-DD (ej. 7/3/2026 → 2026-07-03); si no aparece usa "". Si falta otro dato usa "" o 0. No inventes filas ni incluyas totales.';
  const emparejar = rows => rows.map(r => {
    const porCuenta = clientes.find(c => c.nroCuenta && String(c.nroCuenta) === String(r.cuenta));
    const porNombre = !porCuenta && clientes.find(c => {
      const parts = String(r.nombre || "").toLowerCase().split(" ").filter(Boolean);
      return parts.length >= 1 && c.nombre.toLowerCase().includes(parts[0]) && (parts.length < 2 || c.nombre.toLowerCase().includes(parts[parts.length - 1]));
    });
    const f = String(r.fecha || "").slice(0, 10);
    return { ...r, monto: +(+r.monto || 0).toFixed(2), fecha: /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : "", clienteId: (porCuenta || porNombre)?.id || "", incluir: true };
  });
  const leer = async (f) => {
    setLeyendo(true);
    try {
      const arr = await leerConIA(f, PROMPT);
      if (!Array.isArray(arr) || !arr.length) throw new Error("no encontré pagos en el documento");
      setFilas(emparejar(arr.filter(r => +r.monto > 0)));
    } catch (e) { toast("No pude leer los pagos: " + (e.message || e), "err"); }
    setLeyendo(false);
  };
  const upd = (i, k, v) => setFilas(filas.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const marcados = filas ? filas.filter(f => f.incluir && +f.monto > 0) : [];
  const listos = marcados.filter(f => f.clienteId);      // con cliente en la app: baja su saldo
  const externos = marcados.filter(f => !f.clienteId);   // sin cliente: igual suman al cobrado del mes
  const confirmar = () => {
    if (!marcados.length) return toast("Marca al menos un pago con monto", "err");
    listos.forEach(f => onPago(+f.clienteId || f.clienteId, +f.monto, "Hy Cite", f.fecha));
    if (externos.length && onPagoExterno) onPagoExterno(externos);
    const tot = marcados.reduce((s, f) => s + +f.monto, 0);
    toast(`${marcados.length} pago(s) del día registrados ✓ (${fmt(tot)})${externos.length ? ` · ${externos.length} sin cliente, sumados al mes` : ""}`);
    onClose();
  };
  return <Modal title="IMPORTAR PAGOS DEL DÍA (IA)" onClose={onClose} wide>
    {!filas ? <>
      <div style={{ fontSize: 11, color: T.mut, marginBottom: 12, lineHeight: 1.6 }}>
        Sube la foto o PDF del <b>reporte de pagos diarios</b>. La IA lee cada pago, lo empareja con tu cliente por cuenta o nombre, y tú confirmas antes de registrar. Cada pago baja el saldo del cliente y suma al cobrado del mes.
      </div>
      <BotonSubirIA leyendo={leyendo} onFile={leer} texto="SUBIR FOTO O PDF DE PAGOS" />
    </> : <>
      <div style={{ fontSize: 11, color: T.mut, marginBottom: 12 }}>Revisa el emparejamiento. Los pagos con cliente bajan su saldo; los que queden sin cliente igual se registran y suman al cobrado del mes.</div>
      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        {filas.map((f, i) => <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 1fr 90px", gap: 8, alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
          <input type="checkbox" checked={f.incluir} onChange={e => upd(i, "incluir", e.target.checked)} style={{ width: 16, height: 16, accentColor: T.blueMid }} />
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.text }}>{f.nombre || "(sin nombre)"} <span style={{ color: T.mut, fontWeight: 500 }}>· cta {f.cuenta || "—"}</span></div>
            <div style={{ marginTop: 3 }}>
              <BuscadorCliente clientes={clientes} value={f.clienteId} onChange={v => upd(i, "clienteId", v)} compact placeholder="Asignar: nombre o cuenta…" />
            </div>
          </div>
          <input type="number" value={f.monto} onChange={e => upd(i, "monto", e.target.value)} style={{
            background: "#fff", border: `1.5px solid ${T.border}`, borderRadius: 6, padding: "6px 8px",
            fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text, outline: "none", textAlign: "right", width: "100%", boxSizing: "border-box" }} />
        </div>)}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
        <div style={{ flex: 1, fontSize: 11, color: T.mut }}>{marcados.length} de {filas.length} listos · total <b style={{ color: T.green }}>{fmt(listos.reduce((s, f) => s + +f.monto, 0))}</b></div>
        <Btn onClick={confirmar}><CheckCircle2 size={14} /> REGISTRAR {marcados.length} PAGO(S)</Btn>
      </div>
    </>}
  </Modal>;
};

/* ── TendenciaCartera: control diario de cartera y atrasos (snapshots del mes) ── */
const TendenciaCartera = ({ snaps, isMobile, pagosDespues = 0 }) => {
  const [verNiv, setVerNiv] = useState(false);
  if (!snaps || !snaps.length) return null;
  const ult = snaps[snaps.length - 1];
  const ant = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const atrDe = t => t.d0 + t.d31 + t.d61 + t.d90;
  const atr = atrDe(ult.total);
  const mora = ult.total.cxc > 0 ? atr / ult.total.cxc * 100 : 0;
  const alerta61 = ant && ult.total.d61 > ant.total.d61;
  const deltaCart = ant ? ult.total.cxc - ant.total.cxc : 0;
  const carteraViva = Math.max(0, +(ult.total.cxc - (+pagosDespues || 0)).toFixed(2)); // sincronizada con los pagos de la app
  /* mini gráfica SVG: cartera (azul) y atrasos (naranja) */
  const W = 300, H = 70, PAD = 6;
  const maxY = Math.max(...snaps.map(s => s.total.cxc), 1);
  const px = i => snaps.length > 1 ? PAD + i * (W - PAD * 2) / (snaps.length - 1) : W / 2;
  const py = v => H - PAD - (v / maxY) * (H - PAD * 2);
  const linea = f => snaps.map((s, i) => `${px(i).toFixed(1)},${py(f(s)).toFixed(1)}`).join(" ");
  const celda = { padding: "4px 7px", fontSize: 10, textAlign: "right", borderBottom: `1px solid ${T.bg}` };
  return <Card glow style={{ marginBottom: 20, borderLeft: `3px solid ${alerta61 ? T.red : T.blueMid}` }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
      <div>
        <div style={{ fontFamily: T.serif, fontSize: 16, fontWeight: 700, color: T.blue }}>Control de cartera</div>
        <div style={{ fontSize: 10, color: T.mut, marginTop: 2 }}>Último reporte: {ult.fecha} · {snaps.length} reporte(s) este mes{pagosDespues > 0 ? " · − " + fmt(pagosDespues) + " pagados en la app desde el reporte" : ""}</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: T.mut }}>MORA ACTUAL</div>
        <div style={{ fontFamily: T.serif, fontSize: 20, fontWeight: 700, color: mora >= 25 ? T.red : mora >= 15 ? T.orange : T.green }}>{mora.toFixed(1)}%</div>
      </div>
    </div>
    {alerta61 && <div style={{ background: "#fdecea", border: `1px solid ${T.red}`, borderRadius: 7, padding: "8px 12px", fontSize: 11, color: T.red, fontWeight: 700, marginBottom: 10 }}>
      <Ico e="⚠" className="mr-1.5" />Los atrasos 61-90 subieron de {fmt(ant.total.d61)} a {fmt(ult.total.d61)} desde el reporte anterior. Prioriza esos clientes antes de que pasen a +90.
    </div>}
    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4,1fr)", gap: 6, marginBottom: 12 }}>
      {[["Cartera" + (pagosDespues > 0 ? " (viva)" : ""), carteraViva, T.blue, ant ? deltaCart : null], ["Atrasos", atr, T.orange, ant ? atr - atrDe(ant.total) : null], ["61-90 días", ult.total.d61, T.red, ant ? ult.total.d61 - ant.total.d61 : null], ["+90 días", ult.total.d90, "#7f1d1d", ant ? ult.total.d90 - ant.total.d90 : null]].map(([l, v, c, d]) =>
        <div key={l} style={{ background: T.bg, border: `1px solid ${T.border}`, borderLeft: `3px solid ${c}`, borderRadius: 7, padding: "8px 10px" }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: T.mut, textTransform: "uppercase" }}>{l}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{fmt(v)}</div>
          {d !== null && Math.abs(d) >= 0.01 && <div style={{ fontSize: 9, fontWeight: 700, color: d > 0 ? T.red : T.green }}>{d > 0 ? "▲" : "▼"} {fmt(Math.abs(d))}</div>}
        </div>)}
    </div>
    {snaps.length > 1 && <div style={{ background: "#fff", border: `1px solid ${T.border}`, borderRadius: 7, padding: "8px 10px 4px", marginBottom: 10 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        <polyline points={linea(s => s.total.cxc)} fill="none" stroke={T.blueMid} strokeWidth="2" />
        <polyline points={linea(s => atrDe(s.total))} fill="none" stroke={T.orange} strokeWidth="2" strokeDasharray="4 3" />
        {snaps.map((s, i) => <circle key={"c" + i} cx={px(i)} cy={py(s.total.cxc)} r="2.5" fill={T.blueMid} />)}
        {snaps.map((s, i) => <circle key={"a" + i} cx={px(i)} cy={py(atrDe(s.total))} r="2.5" fill={T.orange} />)}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T.mut, padding: "2px 2px 4px" }}>
        <span>{snaps[0].fecha}</span>
        <span><span style={{ color: T.blueMid, fontWeight: 700 }}>― Cartera</span> · <span style={{ color: T.orange, fontWeight: 700 }}>┅ Atrasos</span></span>
        <span>{ult.fecha}</span>
      </div>
    </div>}
    {ult.niveles && ult.niveles.length > 0 && <>
      <button onClick={() => setVerNiv(v => !v)} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.blueMid, padding: 0 }}>
        {verNiv ? "▾ Ocultar niveles" : "▸ Ver desglose por nivel (" + ult.niveles.length + ")"}
      </button>
      {verNiv && <div style={{ maxHeight: 170, overflowY: "auto", border: `1px solid ${T.border}`, borderRadius: 7, marginTop: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: T.mono }}>
          <thead><tr>{["Nivel", "CxC", "0-30", "31-60", "61-90", "+90"].map(h => <th key={h} style={{ ...celda, textAlign: h === "Nivel" ? "left" : "right", background: T.bluePale, color: T.blue, fontWeight: 700, position: "sticky", top: 0 }}>{h}</th>)}</tr></thead>
          <tbody>{ult.niveles.map(n => <tr key={n.nivel} style={{ background: n.d61 + n.d90 > 0 ? "#fff7ed" : "#fff" }}>
            <td style={{ ...celda, textAlign: "left", fontWeight: 700 }}>{n.nivel}</td>
            <td style={celda}>{fmt(n.cxc)}</td><td style={celda}>{fmt(n.d0)}</td><td style={celda}>{fmt(n.d31)}</td><td style={celda}>{fmt(n.d61)}</td><td style={celda}>{fmt(n.d90)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </>}
  </Card>;
};

/* ── PromesasCard ── */
const PromesasCard = ({
  clientes,
  cfg,
  onPago,
  onRomper
}) => {
  const conPromesa = clientes.filter(c => c.promesa);
  if (!conPromesa.length) return null;
  const hoy = todayISO();
  const estado = p => p.fecha < hoy ? "vencida" : p.fecha === hoy ? "hoy" : "próxima";
  const orden = [...conPromesa].sort((a, b) => (a.promesa.fecha + a.promesa.hora).localeCompare(b.promesa.fecha + b.promesa.hora));
  return <Card style={{
    marginBottom: 20
  }}>
      <SubT><Ico e="🤝" className="mr-1.5" />PROMESAS DE PAGO ({conPromesa.length})</SubT>
      {orden.map((c, i) => {
      const st = estado(c.promesa);
      const col = st === "vencida" ? T.red : st === "hoy" ? T.orange : T.blueMid;
      return <div key={c.id} style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 0",
        borderBottom: i < orden.length - 1 ? `1px solid ${T.border}` : "none",
        flexWrap: "wrap"
      }}>
            <div style={{
          flex: 1,
          minWidth: 140
        }}>
              <div style={{
            fontSize: 12,
            fontWeight: 700
          }}>{c.nombre}</div>
              <div style={{
            fontSize: 10,
            color: col,
            fontWeight: 700
          }}>{st === "vencida" ? <><Ico e="⚠" className="mr-1" />VENCIDA</> : st === "hoy" ? "● HOY" : "PRÓXIMA"} · {c.promesa.fecha} {c.promesa.hora}{c.promesa.monto ? " · " + fmt(c.promesa.monto) : ""}</div>
            </div>
            <Btn style={{
          padding: "6px 10px",
          fontSize: 10
        }} onClick={() => onPago(c.id, c.promesa.monto || c.pagoMensual, "Zelle")}><DollarSign size={12} /> PAGÓ</Btn>
            <a href={waLink(c.tel, `Hola ${c.nombre.split(" ")[0]}, le saluda ${cfg.usuario} de Royal Prestige. Le recuerdo su pago acordado para ${c.promesa.fecha === hoy ? "hoy" : "el " + c.promesa.fecha} a las ${c.promesa.hora}. ¡Gracias! 🙌`)} target="_blank" rel="noreferrer" style={{
          textDecoration: "none"
        }}><Btn variant="ghost" style={{
            padding: "6px 10px"
          }}><MessageCircle size={12} /></Btn></a>
            {st === "vencida" && <Btn variant="danger" style={{
          padding: "6px 10px",
          fontSize: 10
        }} onClick={() => onRomper(c.id)}><XCircle size={12} /> NO CUMPLIÓ</Btn>}
          </div>;
    })}
    </Card>;
};

/* ── MetaMes ── */
const MetaMes = ({
  onPagoExterno,
  mesKey,
  mesCfg,
  setMeses,
  onReporteFin,
  cobradoCartera,
  clientes,
  onPago,
  isMobile,
  puedeEditar = true
}) => {
  const [cfgOpen, setCfgOpen] = useState(false);
  const [pagoOpen, setPagoOpen] = useState(false);
  const [repOpen, setRepOpen] = useState(false);
  const [pagosIAOpen, setPagosIAOpen] = useState(false);
  if (!mesCfg) return <Card glow style={{
    marginBottom: 20,
    borderLeft: `3px solid ${T.orange}`
  }}>
      <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 10
    }}>
        <div>
          <div style={{
          fontFamily: T.serif,
          fontSize: 17,
          fontWeight: 700,
          color: T.blue
        }}>Nuevo mes: {nombreMes(mesKey)}</div>
          <div style={{
          fontSize: 11,
          color: T.mut,
          marginTop: 3
        }}>Captura la cartera inicial del mes para medir tu avance diario.</div>
        </div>
        {puedeEditar ? <div style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap"
      }}>
          <Btn onClick={() => setRepOpen(true)}><FileText size={13} /> IMPORTAR REPORTE FINANCIERO</Btn>
          <Btn variant="ghost" onClick={() => setCfgOpen(true)}><Edit3 size={13} /> CAPTURA MANUAL</Btn>
        </div> : <span style={{
        fontSize: 11,
        color: T.mut
      }}>Pídele al admin configurar el mes</span>}
      </div>
      {cfgOpen && <ConfigMes mesKey={mesKey} mesCfg={mesCfg} setMeses={setMeses} onClose={() => setCfgOpen(false)} />}
      {repOpen && <ImportReporteFin onGuardar={onReporteFin} onClose={() => setRepOpen(false)} />}
    </Card>;
  const metaTotal = (mesCfg.dist + mesCfg.fin) * mesCfg.metaPct / 100;
  const cobradoTotal = cobradoCartera.dist + cobradoCartera.fin;
  const ritmo = Math.max(0, metaTotal - cobradoTotal) / diasRestantesMes();
  const Fila = ({
    k
  }) => {
    const ini = mesCfg[k],
      cob = cobradoCartera[k],
      meta = ini * mesCfg.metaPct / 100;
    const pct = meta > 0 ? Math.min(100, cob / meta * 100) : 100;
    const col = pct >= 100 ? T.green : pct >= 60 ? T.blueMid : T.orange;
    return <div style={{
      marginBottom: 14
    }}>
        <div style={{
        display: "flex",
        justifyContent: "space-between",
        fontSize: 11,
        marginBottom: 5,
        flexWrap: "wrap",
        gap: 4
      }}>
          <span style={{
          fontWeight: 700,
          color: T.blue
        }}>{CARTERAS[k].nombre} <span style={{
            color: T.mut,
            fontWeight: 500
          }}>· cartera {fmt(ini)}</span></span>
          <span style={{
          color: T.mut
        }}>{fmt(cob)} de <b style={{
            color: T.text
          }}>{fmt(meta)}</b> ({Math.round(pct)}%)</span>
        </div>
        <div style={{
        height: 9,
        background: T.bg,
        border: `1px solid ${T.border}`,
        borderRadius: 6,
        overflow: "hidden"
      }}>
          <div style={{
          width: pct + "%",
          height: "100%",
          background: col,
          borderRadius: 6,
          transition: "width .4s"
        }} />
        </div>
      </div>;
  };
  return <Card glow style={{
    marginBottom: 20,
    border: `2px solid ${T.blue}`
  }}>
      <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      marginBottom: 14,
      flexWrap: "wrap",
      gap: 8
    }}>
        <div>
          <div style={{
          fontFamily: T.serif,
          fontSize: 18,
          fontWeight: 700,
          color: T.blue
        }}>Meta de {nombreMes(mesKey)} <em style={{
            color: T.blueLight
          }}>· {mesCfg.metaPct}% de la cartera</em></div>
          <div style={{
          fontSize: 11,
          color: T.mut,
          marginTop: 3
        }}>Quedan {diasRestantesMes()} días · ritmo necesario: <b style={{
            color: T.blue
          }}>{fmt(ritmo)}/día</b></div>
        </div>
        <div style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap"
      }}>
          <Btn onClick={() => setRepOpen(true)} style={{
          padding: "8px 12px",
          fontSize: 11
        }}><FileText size={13} /> REPORTE FINANCIERO</Btn>
          <Btn onClick={() => setPagosIAOpen(true)} style={{
          padding: "8px 12px",
          fontSize: 11
        }}><Camera size={13} /> PAGOS DEL DÍA (IA)</Btn>
          <Btn variant="ghost" onClick={() => setPagoOpen(true)} style={{
          padding: "8px 12px",
          fontSize: 11
        }}><Plus size={13} /> PAGO DEL DÍA</Btn>
          {puedeEditar && <Btn variant="ghost" onClick={() => setCfgOpen(true)} style={{
          padding: "8px 12px",
          fontSize: 11
        }}><Edit3 size={13} /> EDITAR MES</Btn>}
        </div>
      </div>
      <Fila k="dist" />
      <Fila k="fin" />
      <div style={{
      borderTop: `2px solid ${T.blue}`,
      paddingTop: 12,
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      flexWrap: "wrap",
      gap: 6
    }}>
        <span style={{
        fontFamily: T.serif,
        fontSize: 15,
        fontWeight: 700,
        color: T.blue
      }}>Total cobrado del mes</span>
        <span style={{
        fontSize: 17,
        fontWeight: 700,
        color: cobradoTotal >= metaTotal ? T.green : T.text
      }}>{fmt(cobradoTotal)} <span style={{
          fontSize: 11,
          color: T.mut,
          fontWeight: 500
        }}>de {fmt(metaTotal)} · faltan {fmt(Math.max(0, metaTotal - cobradoTotal))}</span></span>
      </div>
      {cfgOpen && <ConfigMes mesKey={mesKey} mesCfg={mesCfg} setMeses={setMeses} onClose={() => setCfgOpen(false)} />}
      {pagoOpen && <QuickPago clientes={clientes} onPago={onPago} onClose={() => setPagoOpen(false)} />}
      {repOpen && <ImportReporteFin onGuardar={onReporteFin} onClose={() => setRepOpen(false)} />}
      {pagosIAOpen && <ImportPagosDia clientes={clientes} onPago={onPago} onPagoExterno={onPagoExterno} onClose={() => setPagosIAOpen(false)} />}
    </Card>;
};

/* ── KpisHyCite ── */
const KpisHyCite = ({
  kpi,
  isMobile,
  irCobranza
}) => {
  const tile = (label, val, meta) => {
    const ok = val < meta;
    return <div style={{
      background: T.bg,
      border: `1px solid ${T.border}`,
      borderRadius: 7,
      padding: 12
    }}>
        <div style={{
        fontSize: 9,
        color: T.mut,
        fontWeight: 700,
        letterSpacing: 0.8
      }}>{label}</div>
        <div style={{
        fontSize: 22,
        fontWeight: 800,
        color: ok ? T.green : T.red,
        marginTop: 4
      }}>{val.toFixed(2)}%</div>
        <div style={{
        fontSize: 9,
        color: T.mut,
        marginTop: 2
      }}>meta Hy Cite &lt; {meta}% {ok ? <><Ico e="✓" className="mr-1" />en verde</> : <><Ico e="⚠" className="mr-1" />fuera de meta</>}</div>
      </div>;
  };
  // Qué se muestra en el tile de cesión: 1º cesión explícita del reporte,
  // 2º el monto +61 días del reporte, 3º el cálculo con los clientes de la app.
  const tieneRep = kpi.rep61 != null;
  const cesMonto = kpi.repCesion ? kpi.repCesion.monto : (tieneRep ? kpi.rep61 : kpi.saldoRiesgo);
  const cesCuentas = kpi.repCesion ? kpi.repCesion.cuentas : (tieneRep ? null : kpi.riesgo.length);
  const cesActivo = (+cesMonto > 0) || ((cesCuentas || 0) > 0);
  return <Card style={{
    marginBottom: 20
  }}>
      <SubT>INDICADORES HY CITE · {kpi.desdeReporte ? "SEGÚN REPORTE" : "ESTIMADOS"}</SubT>
      <div style={{
      display: "grid",
      gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(3,1fr)",
      gap: 10
    }}>
        {tile("% MOROSIDAD 31+", kpi.mora31, 12)}
        {tile("MOROSIDAD TOTAL", kpi.moraTotal, 40)}
        <button onClick={irCobranza} style={{
        textAlign: "left",
        background: cesActivo ? "#fdf3f2" : T.bg,
        border: `1px solid ${cesActivo ? T.red : T.border}`,
        borderRadius: 7,
        padding: 12,
        cursor: "pointer",
        fontFamily: T.mono,
        gridColumn: isMobile ? "1 / -1" : "auto"
      }}>
          <div style={{
          fontSize: 9,
          color: cesActivo ? T.red : T.mut,
          fontWeight: 700,
          letterSpacing: 0.8
        }}>{tieneRep ? <><Ico e="🚨" className="mr-1" />EN CESIÓN · +61 DÍAS · SEGÚN REPORTE</> : <><Ico e="🚨" className="mr-1" />RIESGO DE CESIÓN ESTE MES</>}</div>
          <div style={{
          fontSize: 22,
          fontWeight: 800,
          color: cesActivo ? T.red : T.green,
          marginTop: 4
        }}>{cesCuentas != null ? cesCuentas : fmt(cesMonto)} <span style={{
            fontSize: 12,
            fontWeight: 600
          }}>{cesCuentas != null ? `cuentas · ${fmt(cesMonto)}` : "en cuentas con +61 días"}</span></div>
          <div style={{
          fontSize: 9,
          color: T.mut,
          marginTop: 2
        }}>{tieneRep ? `📄 Reporte Hy Cite del ${kpi.repFecha} — tu cartera a trabajar este mes` : (kpi.riesgo.length ? "Un pago las salva → ir a Rescate" : "Sin cuentas por ceder ✓")}{kpi.salvadas.length ? ` · ${kpi.salvadas.length} salvada(s) ✓` : ""}</div>
          {kpi.atraso60Count > 0 && <div style={{
          fontSize: 10,
          color: T.orange,
          fontWeight: 700,
          marginTop: 6,
          paddingTop: 6,
          borderTop: `1px solid ${T.border}`
        }}>⚠ +60 días de atraso: {kpi.atraso60Count} cuenta(s) · {fmt(kpi.atraso60Saldo)}</div>}
        </button>
      </div>
    </Card>;
};

/* ── Dashboard ── */
const Dashboard = ({
  resumen,
  prioritarios,
  onPagoExterno,
  pagosExternos,
  isMobile,
  irCobranza,
  mesKey,
  mesCfg,
  setMeses,
  cobradoCartera,
  clientes,
  onPago,
  kpi,
  cfg,
  onRomper,
  puedeEditarMes,
  snapsMes,
  onReporteFin,
  pagosDespues
}) => {
  const [verPagosMes, setVerPagosMes] = useState(false);
  const kpis = [{
    label: "COBRADO ESTE MES",
    val: fmt(resumen.cobradoMes),
    icon: TrendingUp,
    color: T.green,
    onClick: () => setVerPagosMes(v => !v)
  }, {
    label: "CRÍTICOS",
    val: resumen.cats.rojo.length,
    icon: Zap,
    color: T.red
  }];
  const catList = [{
    k: "corriente",
    c: T.green,
    n: "AL CORRIENTE",
    sel: cats => cats.verde.filter(c => c.rango !== "0-30")
  }, {
    k: "r030",
    c: "#65a30d",
    n: "ATRASO 0-30",
    sel: cats => cats.verde.filter(c => c.rango === "0-30")
  }, {
    k: "amarillo",
    c: T.yellow,
    n: "MORA 31-60",
    sel: cats => cats.amarillo
  }, {
    k: "naranja",
    c: T.orange,
    n: "MORA 61-90",
    cesion: true,
    sel: cats => cats.naranja
  }, {
    k: "rojo",
    c: T.red,
    n: "CRÍTICO 90+",
    cesion: true,
    sel: cats => cats.rojo
  }];
  const totalClientes = (resumen.cats.verde.length + resumen.cats.amarillo.length + resumen.cats.naranja.length + resumen.cats.rojo.length) || 1;
  // ── Lista de pagos del mes por cliente (para el desglose de "Cobrado este mes") ──
  const mesActual = todayISO().slice(0, 7);
  const pagosMes = [
    ...(clientes || []).flatMap(c => (c.historial || [])
      .filter(h => h.tipo === "pago" && h.fecha && h.fecha.startsWith(mesActual))
      .map(h => ({ nombre: c.nombre, monto: h.monto, fecha: h.fecha, metodo: h.metodo || "" }))),
    ...((pagosExternos || []).filter(h => h.fecha && h.fecha.startsWith(mesActual))
      .map(h => ({ nombre: (h.nombre || "(sin nombre)") + " · Hy Cite", monto: h.monto, fecha: h.fecha, metodo: h.origen || "" })))
  ].sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
  return <div>
      <H1>Panel de Control</H1>
      <MetaMes mesKey={mesKey} mesCfg={mesCfg} setMeses={setMeses} cobradoCartera={cobradoCartera} clientes={clientes} onPago={onPago} onPagoExterno={onPagoExterno} isMobile={isMobile} puedeEditar={puedeEditarMes} onReporteFin={onReporteFin} />
      <TendenciaCartera snaps={snapsMes} isMobile={isMobile} pagosDespues={pagosDespues} />
      <KpisHyCite kpi={kpi} isMobile={isMobile} irCobranza={irCobranza} />
      <PromesasCard clientes={clientes} cfg={cfg} onPago={onPago} onRomper={onRomper} />
      <div style={{
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 12,
      marginBottom: 20
    }}>
        {kpis.map(k => <Card key={k.label} onClick={k.onClick} style={k.onClick ? { cursor: "pointer" } : undefined}>
            <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}>
              <span style={{
            fontSize: 9,
            color: T.mut,
            letterSpacing: 1
          }}>{k.label}</span><k.icon size={14} color={k.color} />
            </div>
            <div style={{
          fontSize: isMobile ? 17 : 22,
          fontWeight: 800,
          color: k.color,
          marginTop: 8
        }}>{k.val}</div>
            {k.onClick && <div style={{
          fontSize: 9,
          color: T.blueMid,
          fontWeight: 700,
          marginTop: 4
        }}>{verPagosMes ? "▲ ocultar detalle" : `▼ ver ${pagosMes.length} pago(s)`}</div>}
          </Card>)}
      </div>
      {verPagosMes && <Card style={{ marginBottom: 20 }}>
        <SubT>PAGOS DE {nombreMes(mesKey).toUpperCase()} · {pagosMes.length}</SubT>
        {pagosMes.length === 0 && <div style={{ fontSize: 12, color: T.mut, padding: "8px 0" }}>Aún no hay pagos registrados este mes.</div>}
        {pagosMes.map((p, i) => <div key={i} style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 0",
          borderBottom: `1px solid ${T.border}`,
          gap: 10
        }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.nombre}</div>
              <div style={{ fontSize: 10, color: T.mut }}>{p.fecha}{p.metodo ? ` · ${p.metodo}` : ""}</div>
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, color: T.green }}>{fmt(p.monto)}</div>
          </div>)}
        {pagosMes.length > 0 && <div style={{
          display: "flex",
          justifyContent: "space-between",
          padding: "10px 0 0",
          fontSize: 13,
          fontWeight: 800
        }}><span>TOTAL</span><span style={{ color: T.green }}>{fmt(pagosMes.reduce((s, p) => s + p.monto, 0))}</span></div>}
      </Card>}
      <Card style={{
      marginBottom: 20
    }}>
        <SubT>SEMÁFORO DE CARTERA</SubT>
        {(() => {
        // Con reporte del mes: los montos y % salen DIRECTO del Control de
        // Cartera (Hy Cite) → verde = cxc − mora, y cada rango con su monto.
        const ultRep = snapsMes && snapsMes.length ? snapsMes[snapsMes.length - 1] : null;
        const repMap = ultRep ? {
          verde: Math.max(0, +(ultRep.total.cxc - ultRep.total.d31 - ultRep.total.d61 - ultRep.total.d90).toFixed(2)),
          amarillo: ultRep.total.d31, naranja: ultRep.total.d61, rojo: ultRep.total.d90
        } : null;
        return <>
        {ultRep && <div style={{ fontSize: 9, color: T.mut, marginBottom: 8 }}>Proporcional al Control de Cartera · reporte del {ultRep.fecha}</div>}
        {catList.map(x => {
        const arr = x.sel(resumen.cats);
        const monto = (() => {
          if (!repMap) return arr.reduce((s, c) => s + c.saldo, 0);
          if (x.k !== "corriente" && x.k !== "r030") return repMap[x.k];
          // El reporte Hy Cite no separa 0-30 de al corriente: se reparte el monto verde
          // proporcional al saldo real de cada grupo de clientes.
          const sC = resumen.cats.verde.filter(c => c.rango !== "0-30").reduce((s, c) => s + c.saldo, 0);
          const s3 = resumen.cats.verde.filter(c => c.rango === "0-30").reduce((s, c) => s + c.saldo, 0);
          const tot = sC + s3;
          if (tot <= 0) return x.k === "corriente" ? repMap.verde : 0;
          return repMap.verde * (x.k === "corriente" ? sC : s3) / tot;
        })();
        const pct = repMap
          ? (ultRep.total.cxc > 0 ? Math.round(monto / ultRep.total.cxc * 100) : 0)
          : Math.round(arr.length / totalClientes * 100);
        return <div key={x.k} style={{
          marginBottom: 12
        }}>
              <div style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            marginBottom: 4
          }}>
                <span style={{
              color: x.c,
              fontWeight: 700
            }}>● {x.n}{x.cesion ? " · ⚠ CESIÓN" : ""} <span style={{
                color: T.mut
              }}>({arr.length})</span></span>
                <span style={{
              color: T.mut
            }}>{fmt(monto)}</span>
              </div>
              <div style={{
            height: 5,
            background: T.panel2,
            borderRadius: 2
          }}>
                <div style={{
              width: pct + "%",
              height: "100%",
              background: x.c,
              borderRadius: 2,
              boxShadow: `0 0 8px ${x.c}55`
            }} />
              </div>
            </div>;
      })}
        {(() => {
        const rc = [...resumen.cats.naranja, ...resumen.cats.rojo];
        const m = rc.reduce((s, c) => s + c.saldo, 0);
        return rc.length > 0 && <div style={{
          fontSize: 10,
          fontWeight: 700,
          color: T.red,
          background: "#fef2f2",
          border: `1.5px solid ${T.red}`,
          borderRadius: 8,
          padding: "6px 10px",
          marginTop: 4
        }}><Ico e="⚠" className="mr-1.5" />RIESGO DE CESIÓN (más de 60 días): {rc.length} cliente(s) · {fmt(m)}</div>;
      })()}
        </>;
      })()}
      </Card>
      <Card glow>
        <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 12
      }}>
          <SubT style={{
          margin: 0
        }}><Ico e="🔥" className="mr-1.5" />Prioritarios de Hoy</SubT>
          <Btn variant="ghost" onClick={irCobranza} style={{
          padding: "6px 12px",
          fontSize: 10
        }}>IR A COBRANZA <ChevronRight size={12} /></Btn>
        </div>
        {prioritarios.slice(0, 5).map((c, i) => <div key={c.id} style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 0",
        borderBottom: i < 4 ? `1px solid ${T.border}` : "none"
      }}>
            <span style={{
          color: T.mut,
          fontSize: 11,
          width: 18
        }}>{i + 1}.</span>
            <div style={{
          flex: 1,
          minWidth: 0
        }}>
              <div style={{
            fontSize: 12,
            fontWeight: 700,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis"
          }}>{c.nombre}</div>
              <div style={{
            fontSize: 10,
            color: T.mut
          }}>{c.rango ? `atraso ${c.rango==="coleccion"?"colección":c.rango}` : Number.isFinite(c.dias) ? `${c.dias}d sin pago` : "sin datos de pago"} · {fmt(c.saldo)}</div>
            </div>
            <span style={{
          fontSize: 10,
          color: c.sem.color,
          fontWeight: 700
        }}>SCORE {c.score}</span>
            <Badge sem={c.sem} />
          </div>)}
      </Card>
    </div>;
};

/* ── FormCliente ── */
const FormCliente = ({
  c,
  onClose,
  onGuardar,
  disponibles
}) => {
  const nuevo = !c;
  const [pick, setPick] = useState(null);
  const [busq, setBusq] = useState("");
  const base = c || pick;
  const [f, setF] = useState(() => ({
    cartera: c && c.cartera || "dist",
    nombre: c && c.nombre || "",
    tel: c && c.tel || "",
    nroCuenta: c && c.nroCuenta || "",
    ciudad: c && c.ciudad || "",
    direccion: c && c.direccion || "",
    saldo: c && c.saldo != null && c.saldo !== "" ? c.saldo : "",
    pagoMensual: c && c.pagoMensual ? c.pagoMensual : "",
    nivel: c && c.nivel ? c.nivel : "",
    ultimoPago: c && c.ultimoPago || todayISO(),
    email: c && c.email || "",
    tipoCuenta: c && c.tipoCuenta || "",
    metodoPago: c && c.metodoPago || "",
    estado: c && c.estado || "Activo",
    cargoVueltaFecha: c && c.cargoVueltaFecha || "",
    cargoVueltaMonto: c && c.cargoVueltaMonto || "",
    nota: c && c.nota || "",
    referencias: c && c.referencias || []
  }));
  const [errs, setErrs] = useState({});
  const lista = (disponibles || []).filter(d => ((d.nombre || "") + (d.ciudad || "") + (d.telefono || "") + (d.cuenta || "")).toLowerCase().includes(busq.toLowerCase())).slice(0, 40);
  const guardar = () => {
    const e = {};
    if (nuevo && f.cartera !== "fin" && !pick) e.pick = "Elige un cliente de Distribución";
    if (nuevo && f.cartera === "fin" && !(f.nombre || "").trim()) e.nombre = "Nombre requerido";
    if (f.saldo === "" || isNaN(+f.saldo) || +f.saldo < 0) e.saldo = "Monto válido requerido";
    if (f.pagoMensual === "" || isNaN(+f.pagoMensual) || +f.pagoMensual <= 0) e.pagoMensual = "Monto válido requerido";
    if (f.nivel !== "" && (+f.nivel < 1 || +f.nivel > 9)) e.nivel = "Nivel entre 1 y 9";
    setErrs(e);
    if (Object.keys(e).length) return;
    const ident = c ? {
      nombre: (f.nombre || "").trim() || c.nombre || "",
      tel: (f.tel || "").trim(),
      nroCuenta: (f.nroCuenta || "").trim(),
      ciudad: (f.ciudad || "").trim(),
      direccion: (f.direccion || "").trim()
    } : (nuevo && f.cartera === "fin") ? {
      nombre: (f.nombre || "").trim(),
      tel: (f.tel || "").trim(),
      nroCuenta: (f.nroCuenta || "").trim(),
      ciudad: (f.ciudad || "").trim(),
      direccion: (f.direccion || "").trim()
    } : base ? {
      nombre: base.nombre || "",
      tel: base.telefono || base.tel || "",
      nroCuenta: base.cuenta || base.nroCuenta || "",
      ciudad: base.ciudad || "",
      direccion: base.direccion || ""
    } : {};
    const payload = {
      ...ident,
      cartera: f.cartera,
      saldo: +f.saldo,
      pagoMensual: +f.pagoMensual,
      nivel: f.nivel === "" ? "" : +f.nivel,
      ultimoPago: f.ultimoPago,
      email: f.email,
      tipoCuenta: f.tipoCuenta,
      metodoPago: f.metodoPago,
      estado: f.estado,
      cargoVueltaFecha: f.cargoVueltaFecha,
      cargoVueltaMonto: f.cargoVueltaMonto,
      nota: f.nota,
      referencias: (f.referencias || []).filter(r => (r.nombre || "").trim())
    };
    if (nuevo) payload._pickId = pick ? pick.id : "fin-" + genId();
    onGuardar(payload, c ? c.id : null);
  };
  const set = k => e => setF({
    ...f,
    [k]: e.target.value
  });
  const setRef = (i, k, v) => setF({
    ...f,
    referencias: f.referencias.map((r, j) => j === i ? {
      ...r,
      [k]: v
    } : r)
  });
  const inpBox = {
    width: "100%",
    boxSizing: "border-box",
    background: "#fff",
    border: `2px solid ${T.border}`,
    borderRadius: 7,
    color: T.text,
    fontFamily: T.mono,
    fontSize: 13,
    fontWeight: 600,
    padding: "9px 10px",
    outline: "none"
  };
  const lbl = {
    fontSize: 11,
    color: T.blueMid,
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: "uppercase"
  };
  return <Modal title={c ? "FICHA DE COBRANZA" : "AGREGAR CLIENTE A COBRANZA"} onClose={onClose} wide>
      {nuevo && !pick && f.cartera !== "fin" && <div style={{
      marginBottom: 14
    }}>
          <SubT>ELIGE UN CLIENTE DE DISTRIBUCIÓN</SubT>
          <div style={{
        position: "relative",
        marginBottom: 8
      }}>
            <Search size={14} style={{
          position: "absolute",
          left: 10,
          top: "50%",
          transform: "translateY(-50%)",
          color: T.mut
        }} />
            <input autoFocus value={busq} onChange={e => setBusq(e.target.value)} placeholder="Buscar por nombre, ciudad, teléfono o cuenta…" style={{
          ...inpBox,
          padding: "10px 12px 10px 32px"
        }} />
          </div>
          {errs.pick && <div style={{
        color: T.red,
        fontSize: 11,
        fontWeight: 700,
        marginBottom: 6
      }}>{errs.pick}</div>}
          <div style={{
        maxHeight: 260,
        overflowY: "auto",
        border: `1px solid ${T.border}`,
        borderRadius: 7
      }}>
            {lista.map(d => <div key={d.id} onClick={() => setPick(d)} style={{
          padding: "10px 12px",
          borderBottom: `1px solid ${T.border}`,
          cursor: "pointer"
        }}>
                <div style={{
            fontSize: 13,
            fontWeight: 700,
            color: T.text
          }}>{d.nombre || "(sin nombre)"}</div>
                <div style={{
            fontSize: 10,
            color: T.mut
          }}>{[d.ciudad, d.telefono, d.cuenta && "Cta " + d.cuenta].filter(Boolean).join(" · ")}</div>
              </div>)}
            {!lista.length && <div style={{
          padding: 16,
          textAlign: "center",
          color: T.mut,
          fontSize: 12
        }}>{(disponibles || []).length ? "Sin coincidencias." : "No hay clientes de Distribución disponibles (o ya están todos en cobranza)."}</div>}
          </div>
          <button onClick={() => setF({ ...f, cartera: "fin" })} style={{
        width: "100%",
        marginTop: 10,
        padding: "10px 12px",
        background: "#fff",
        border: `2px dashed ${T.blueMid}`,
        borderRadius: 8,
        color: T.blueMid,
        fontFamily: T.mono,
        fontSize: 11,
        fontWeight: 700,
        cursor: "pointer"
      }}><Ico e="🏦" className="mr-1.5" />¿ES DE TU FINANCIERA? AGRÉGALO MANUAL AQUÍ</button>
        </div>}

      {(base || (nuevo && f.cartera === "fin")) && <div>
          {(!nuevo || f.cartera === "fin") && <div style={{ marginBottom: 6 }}>
            <SubT>{nuevo ? "DATOS DEL CLIENTE DE TU FINANCIERA" : "DATOS DEL CLIENTE · EDITABLES"}</SubT>
            <Input label="Nombre completo" value={f.nombre} onChange={set("nombre")} error={errs.nombre} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Input label="Teléfono" value={f.tel} onChange={set("tel")} />
              <Input label="Nº de cuenta" value={f.nroCuenta} onChange={set("nroCuenta")} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Input label="Ciudad" value={f.ciudad} onChange={set("ciudad")} />
              <Input label="Dirección" value={f.direccion} onChange={set("direccion")} />
            </div>
          </div>}
          {nuevo && base && <div style={{
        background: T.bluePale,
        border: `1px solid ${T.borderHi}`,
        borderRadius: 8,
        padding: 12,
        marginBottom: 14
      }}>
            <div style={{
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: 1,
          color: T.blueMid,
          marginBottom: 6
        }}>DATOS DESDE DISTRIBUCIÓN · SE SINCRONIZAN SOLOS</div>
            <div style={{
          fontSize: 15,
          fontWeight: 800,
          color: T.blue
        }}>{base.nombre || "—"}</div>
            <div style={{
          fontSize: 11,
          color: T.text,
          marginTop: 3,
          lineHeight: 1.6
        }}>
              {[base.telefono || base.tel, base.ciudad, (base.cuenta || base.nroCuenta) && "Cuenta " + (base.cuenta || base.nroCuenta), base.direccion].filter(Boolean).join(" · ") || "—"}
            </div>
            {nuevo && <button onClick={() => setPick(null)} style={{
          marginTop: 8,
          background: "transparent",
          border: `1px solid ${T.border}`,
          borderRadius: 6,
          color: T.mut,
          fontSize: 10,
          fontWeight: 700,
          padding: "5px 9px",
          cursor: "pointer"
        }}>← Cambiar cliente</button>}
          </div>}

          <SubT>CARTERA</SubT>
          <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 8,
        marginBottom: 14
      }}>
            {["dist", "fin"].map(k => <button key={k} onClick={() => setF({
          ...f,
          cartera: k
        })} style={{
          padding: 10,
          background: (f.cartera || "dist") === k ? T.bluePale : "#fff",
          border: `2px solid ${(f.cartera || "dist") === k ? T.blueMid : T.border}`,
          borderRadius: 7,
          color: (f.cartera || "dist") === k ? T.blueMid : T.mut,
          fontFamily: T.mono,
          fontSize: 11,
          fontWeight: 700,
          cursor: "pointer"
        }}>{CARTERAS[k].nombre}</button>)}
          </div>

          <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 10
      }}>
            <Input label="Cuota mensual ($)" type="number" value={f.pagoMensual} onChange={set("pagoMensual")} error={errs.pagoMensual} />
            <Input label="Valor total pendiente ($)" type="number" value={f.saldo} onChange={set("saldo")} error={errs.saldo} />
            <label style={{
          display: "block",
          marginBottom: 12
        }}>
              <span style={lbl}>Nivel crédito (1-9)</span>
              <select value={f.nivel} onChange={set("nivel")} style={{
            ...inpBox,
            fontSize: 14,
            padding: "10px 12px",
            border: `2px solid ${errs.nivel ? T.red : T.border}`
          }}>
                <option value="">—</option>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>

          <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 10
      }}>
            <Input label="Email" value={f.email} onChange={set("email")} />
            <Input label="Último pago" type="date" value={f.ultimoPago} onChange={set("ultimoPago")} />
          </div>

          <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 10
      }}>
            <label style={{
          display: "block",
          marginBottom: 12
        }}>
              <span style={lbl}>Tipo de cuenta</span>
              <select value={f.tipoCuenta} onChange={set("tipoCuenta")} style={{
            ...inpBox,
            fontSize: 13,
            padding: "10px 12px"
          }}>
                <option value="">—</option><option>Revolving</option><option>Installment</option>
              </select>
            </label>
            <label style={{
          display: "block",
          marginBottom: 12
        }}>
              <span style={lbl}>Método de pago</span>
              <select value={f.metodoPago} onChange={set("metodoPago")} style={{
            ...inpBox,
            fontSize: 13,
            padding: "10px 12px"
          }}>
                <option value="">—</option><option>Tarjeta de crédito</option><option>Tarjeta de débito</option><option>Cheque</option><option>Efectivo</option>
              </select>
            </label>
            <label style={{
          display: "block",
          marginBottom: 12
        }}>
              <span style={lbl}>Estado</span>
              <select value={f.estado} onChange={set("estado")} style={{
            ...inpBox,
            fontSize: 13,
            padding: "10px 12px",
            border: `2px solid ${f.estado === "Cargo de Vuelta" ? T.red : T.border}`,
            color: f.estado === "Cargo de Vuelta" ? T.red : T.text
          }}>
                <option>Activo</option><option>Cargo de Vuelta</option><option>Colección</option>
              </select>
            </label>
          </div>

          {f.estado === "Cargo de Vuelta" && <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 10
      }}>
              <Input label="Fecha del cargo de vuelta" type="date" value={f.cargoVueltaFecha} onChange={set("cargoVueltaFecha")} />
              <Input label="Monto del cargo ($)" type="number" value={f.cargoVueltaMonto} onChange={set("cargoVueltaMonto")} />
            </div>}

          <SubT>REFERENCIAS</SubT>
          {(f.referencias || []).map((r, i) => <div key={i} style={{
        display: "grid",
        gridTemplateColumns: "2fr 2fr auto",
        gap: 8,
        marginBottom: 8
      }}>
              <input value={r.nombre} onChange={e => setRef(i, "nombre", e.target.value)} placeholder="Nombre de la referencia" style={{
          ...inpBox,
          fontWeight: 500
        }} />
              <input value={r.tel} onChange={e => setRef(i, "tel", e.target.value)} placeholder="Teléfono" style={{
          ...inpBox,
          fontWeight: 500
        }} />
              <Btn variant="danger" style={{
          padding: "6px 10px"
        }} onClick={() => setF({
          ...f,
          referencias: f.referencias.filter((_, j) => j !== i)
        })}><Trash2 size={12} /></Btn>
            </div>)}
          <Btn variant="ghost" style={{
        marginBottom: 14,
        padding: "7px 12px",
        fontSize: 11
      }} onClick={() => setF({
        ...f,
        referencias: [...(f.referencias || []), {
          nombre: "",
          tel: ""
        }]
      })}><Plus size={12} /> AGREGAR REFERENCIA</Btn>

          <label style={{
        display: "block",
        marginBottom: 16
      }}>
            <span style={lbl}>Nota de cobranza</span>
            <textarea value={f.nota} onChange={set("nota")} rows={3} placeholder="Ej. Pagar después del día 15, contestar por la tarde…" style={{
          ...inpBox,
          fontWeight: 500,
          padding: 12,
          resize: "vertical",
          lineHeight: 1.5
        }} />
          </label>

          <Btn onClick={guardar} style={{
        width: "100%",
        justifyContent: "center"
      }}><CheckCircle2 size={14} /> {c ? "GUARDAR FICHA" : "AGREGAR A COBRANZA"}</Btn>
        </div>}
    </Modal>;
};
const FormPago = ({
  c,
  onClose,
  onPago
}) => {
  const [monto, setMonto] = useState(c.pagoMensual);
  const [metodo, setMetodo] = useState("Zelle");
  const [err, setErr] = useState("");
  const ok = () => {
    const m = +monto;
    if (isNaN(m) || m <= 0) return setErr("Ingresa un monto mayor a cero");
    if (m > c.saldo) return setErr(`El monto excede el saldo (${fmt(c.saldo)})`);
    onPago(m, metodo);
  };
  return <Modal title={"REGISTRAR PAGO · " + c.nombre.split(" ")[0].toUpperCase()} onClose={onClose}>
      <div style={{
      fontSize: 11,
      color: T.mut,
      marginBottom: 12
    }}>Balance actual: <b style={{
        color: T.text
      }}>{fmt(c.saldo)}</b></div>
      <Input label="Monto ($)" type="number" value={monto} onChange={e => {
      setMonto(e.target.value);
      setErr("");
    }} error={err} />
      <SubT>MÉTODO</SubT>
      <div style={{
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 8,
      marginBottom: 16
    }}>
        {["Zelle", "Cash App", "Efectivo", "Tarjeta"].map(m => <button key={m} onClick={() => setMetodo(m)} style={{
        padding: 10,
        background: metodo === m ? T.bluePale : "#fff",
        border: `2px solid ${metodo === m ? T.blueMid : T.border}`,
        borderRadius: 7,
        color: metodo === m ? T.blueMid : T.mut,
        fontFamily: T.mono,
        fontSize: 11,
        fontWeight: 700,
        cursor: "pointer"
      }}>{m.toUpperCase()}</button>)}
      </div>
      <Btn onClick={ok} style={{
      width: "100%",
      justifyContent: "center"
    }}><DollarSign size={14} /> CONFIRMAR PAGO</Btn>
    </Modal>;
};

/* ── Clientes ── */
/* ── IMPORTAR CLIENTES CON IA (documentos o fotos → Mi Financiera o Distribución) ── */
const ImportClientesIA = ({ onClose, onImportar }) => {
  const [files, setFiles] = useState([]);
  const [cartera, setCartera] = useState("dist");
  const [modelo, setModelo] = useState("sonnet"); // fotos Hy Cite: Sonnet lee mucho mejor el ESTADO
  const [loading, setLoading] = useState(false);
  const [progreso, setProgreso] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);
  const MODELOS_IA = {
    haiku:  { id: "claude-haiku-4-5-20251001", ico:"⚡", label: "Rápido",  desc: "Listas digitales y PDFs claros" },
    sonnet: { id: "claude-sonnet-4-5",         ico:"🧠", label: "Preciso", desc: "Fotos y letra a mano" },
  };
  const handleFiles = e => {
    const nuevos = Array.from(e.target.files || []);
    if (!nuevos.length) return;
    setFiles(prev => [...prev, ...nuevos].slice(0, 20));
    setPreview(null); setError("");
  };
  const quitar = i => setFiles(prev => prev.filter((_, j) => j !== i));
  const quitarReg = i => setPreview(prev => prev.filter((_, j) => j !== i));

  const prepararArchivo = async file => {
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("No se pudo leer el archivo")); r.readAsDataURL(file); });
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
    let mediaType = (file.type || "").toLowerCase();
    if (!isPdf) {
      const name = (file.name || "").toLowerCase();
      if (mediaType === "image/jpg") mediaType = "image/jpeg";
      if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mediaType)) {
        if (/\.(jpe?g)$/i.test(name)) mediaType = "image/jpeg";
        else if (/\.png$/i.test(name)) mediaType = "image/png";
        else if (/\.gif$/i.test(name)) mediaType = "image/gif";
        else if (/\.webp$/i.test(name)) mediaType = "image/webp";
        else if (/\.(heic|heif)$/i.test(name)) { throw new Error("El formato HEIC del iPhone no es compatible (" + file.name + "). En tu iPhone ve a Ajustes → Cámara → Formatos → 'Más compatible', o usa una captura de pantalla."); }
        else mediaType = "image/jpeg";
      }
    }
    const sizeMB = b64.length * 0.75 / (1024 * 1024);
    if (sizeMB > 4.5) throw new Error("Una imagen es muy grande (" + sizeMB.toFixed(1) + "MB: " + file.name + "). Usa una captura de pantalla o redúcela.");
    return isPdf ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } } : { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } };
  };

  const extraerUno = async block => {
    const sys = `Extrae TODOS los clientes con datos de cobranza del documento (portal Hy Cite / distributors.hycite.com) para Royal Prestige. Responde SOLO JSON compacto sin backticks ni explicaciones.

Cada cliente aparece como una tarjeta con un encabezado tipo "HC - Nombre Apellido" y una lista de campos. Mapea así:
- "HC - <Nombre>"  → el nombre del cliente (quita el prefijo "HC -").
- "N.° DE CLIENTE" / "N.º DE CLIENTE" / "Customer #"  → numeroCuenta (solo dígitos).
- "DIRECCIÓN DE CORREO ELECTRÓNICO" / "Email"  → email.
- "TELÉFONO MÓVIL" / "Mobile Phone"  → telefono.
- "SALDO ACTUAL" / "Current Balance"  → saldo (solo el número, sin $ ni "USD").
- "MOROSO" / "Past Due"  → atraso (solo el número; ESTE es el monto en atraso/mora del cliente).
- "EMPRENDEDORES" / "Entrepreneur"  → código del emprendedor, guárdalo en "emprendedor".
- "ESTADO" / "Status"  → ⚠️ CAMPO MÁS IMPORTANTE: aquí viene el ATRASO EN DÍAS como texto (suele estar en un recuadro de color rojo/azul). LÉELO SIEMPRE y conviértelo al campo "rango". Copia además el texto EXACTO en "estadoTexto". Conversión:
    · "Al día" / "Current" / "0 a 30" / "1 a 30 días"  → "0-30"
    · "De 31 a 60 días de atraso"  → "31-60"
    · "De 61 a 90 días de atraso"  → "61-90"
    · "De 91" o más / "Over 90" / "91 y más" / "más de 90"  → "91+"
    · "Cargo de vuelta" / "Colección" / "Charge back"  → "coleccion"
  Y si el texto da un número de días concreto, ponlo también en "diasAtraso".

IMPORTANTÍSIMO: el campo "MOROSO" es el monto en atraso → va en "atraso". El "SALDO ACTUAL" es el total → va en "saldo". NO los confundas.
La línea "Fecha del último pedido" / "último pedido" / "last order" NO es un pago: IGNÓRALA por completo. En este formato de tarjetas NO existe fecha de pago, así que el campo "ultimoPago" SIEMPRE va vacío "".
Si el documento tuviera un formato de tabla con columnas 0-30 / 31-60 / 61-90 / 91+, ubica al cliente en la columna donde tenga monto y usa eso como "rango".
NO inventes datos. Si un campo no aparece, déjalo vacío "".
ADEMÁS: copia el texto del ESTADO tal cual aparece (ej. "De 61 a 90 días de atraso") en el campo "estadoTexto".
Formato EXACTO: {"registros":[{"nombre":"","telefono":"","numeroCuenta":"","direccion":"","ciudad":"","email":"","saldo":"","pagoMensual":"","ultimoPago":"","rango":"","diasAtraso":"","atraso":"","emprendedor":"","estadoTexto":""}]}. Incluye TODOS los clientes visibles, no te detengas.`;
    let resp;
    try {
      resp = await fetch("/api/anthropic", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODELOS_IA[modelo].id, max_tokens: 8000, system: sys, messages: [{ role: "user", content: [block, { type: "text", text: "Extrae los datos. Solo JSON." }] }] }) });
    } catch (netErr) {
      throw new Error("No se pudo conectar con el servicio de IA. Revisa tu conexión a internet.");
    }
    if (!resp.ok) {
      let msg = "Error " + resp.status;
      try { const e = await resp.json(); msg = e.error && e.error.message || msg; } catch {}
      if (resp.status === 401) msg = "API key inválida o sin créditos. Revisa tu cuenta de Anthropic.";
      if (resp.status === 400) msg = "Una imagen no se pudo procesar. Intenta con una captura más clara.";
      if (resp.status === 413) msg = "Una imagen es muy grande. Usa captura de pantalla.";
      if (resp.status === 529 || resp.status === 429) msg = "El servicio est�� ocupado. Espera unos segundos e intenta de nuevo.";
      throw new Error(msg);
    }
    const data = await resp.json();
    const text = (data.content || []).map(b => b.text || "").join("");
    if (!text.trim()) return { registros: [] };
    let clean = text.replace(/```json|```/g, "").trim();
    const fb = clean.indexOf("{"); const lb = clean.lastIndexOf("}");
    if (fb >= 0 && lb > fb) clean = clean.slice(fb, lb + 1);
    try { return JSON.parse(clean); }
    catch {
      const objs = clean.match(/\{[^{}]*\}/g) || [];
      return { registros: objs.map(o => { try { return JSON.parse(o); } catch { return null; } }).filter(Boolean) };
    }
  };

  const num = v => { const n = parseFloat(String(v || "").replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; };
  const extraer = async () => {
    if (!files.length) { setError("Primero selecciona uno o más archivos."); return; }
    setLoading(true); setError(""); setProgreso("");
    try {
      let acum = [];
      for (let i = 0; i < files.length; i++) {
        setProgreso(`Procesando ${i + 1} de ${files.length}…`);
        const block = await prepararArchivo(files[i]);
        const parsed = await extraerUno(block);
        acum = acum.concat(parsed.registros || []);
      }
      setProgreso("");
      const validos = acum.filter(r => (r.nombre || "").trim() || String(r.telefono || "").replace(/\D/g, ""));
      if (!validos.length) throw new Error("No se encontraron clientes en los archivos.");
      setPreview(validos.map(r => ({
        nombre: (r.nombre || "").trim(),
        telefono: (r.telefono || "").trim(),
        numeroCuenta: (r.numeroCuenta || "").trim(),
        direccion: (r.direccion || "").trim(),
        ciudad: (r.ciudad || "").trim(),
        email: (r.email || "").trim(),
        saldo: num(r.saldo),
        pagoMensual: num(r.pagoMensual),
        ultimoPago: /^\d{4}-\d{2}-\d{2}$/.test(r.ultimoPago || "") ? r.ultimoPago : "",
        // CAMPOS DE ATRASO del reporte Hy Cite — antes se perdían aquí y el
        // cliente nunca quedaba en su zona (0-30/31-60/61-90/91+).
        rango: rangoDeRegistro(r),
        estadoTexto: (r.estadoTexto || r.estado || r.status || "").toString().trim(),
        diasAtraso: r.diasAtraso,
        atraso: num(r.atraso),
        emprendedor: (r.emprendedor || "").trim()
      })));
    } catch (err) {
      setError("⚠️ " + (err.message || "No se pudo extraer. Verifica los archivos e intenta de nuevo."));
      setProgreso("");
    }
    setLoading(false);
  };
  const confirmar = () => { if (!preview || !preview.length) return; onImportar(preview, cartera); };

  const chip = act => ({ padding: 10, background: act ? T.bluePale : "#fff", border: `2px solid ${act ? T.blueMid : T.border}`, borderRadius: 7, color: act ? T.blueMid : T.mut, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer", textAlign: "center" });

  return <Modal title="🤖 IMPORTAR CLIENTES CON IA" onClose={onClose} wide>
      {!preview && <div>
        <SubT>¿A QUÉ CARTERA VAN LOS CLIENTES?</SubT>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
          {["dist", "fin"].map(k => <button key={k} onClick={() => setCartera(k)} style={chip(cartera === k)}>{CARTERAS[k].nombre}</button>)}
        </div>
        <SubT>MODO DE LECTURA</SubT>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
          {Object.keys(MODELOS_IA).map(k => <button key={k} onClick={() => setModelo(k)} style={chip(modelo === k)}>
            <div>{MODELOS_IA[k].label}</div>
            <div style={{ fontSize: 9, fontWeight: 600, marginTop: 2, color: T.mut }}>{MODELOS_IA[k].desc}</div>
          </button>)}
        </div>
        <SubT>DOCUMENTOS O FOTOS (hasta 20)</SubT>
        <label style={{ display: "block", border: `2px dashed ${T.borderHi}`, borderRadius: 8, padding: "18px 12px", textAlign: "center", cursor: "pointer", marginBottom: 10, background: T.bluePale }}>
          <div style={{ fontSize: 22 }}>📷 📄</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.blueMid, marginTop: 4 }}>Toca para elegir fotos o PDF</div>
          <div style={{ fontSize: 10, color: T.mut, marginTop: 2 }}>Estados de cuenta, listas, contratos, capturas…</div>
          <input type="file" accept="image/*,application/pdf" multiple onChange={handleFiles} style={{ display: "none" }} />
        </label>
        {files.map((fl, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, padding: "7px 10px", border: `1px solid ${T.border}`, borderRadius: 7, marginBottom: 6 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fl.type === "application/pdf" || /\.pdf$/i.test(fl.name) ? "📄" : "🖼️"} {fl.name}</span>
          <button onClick={() => quitar(i)} style={{ background: "none", border: "none", color: T.red, cursor: "pointer", fontWeight: 800 }}><Ico e="✕" /></button>
        </div>)}
        {error && <div style={{ color: T.red, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>{error}</div>}
        {progreso && <div style={{ color: T.blueMid, fontSize: 11, fontWeight: 700, marginBottom: 8 }}><Ico e="⏳" className="mr-1.5" />{progreso}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={onClose}>CANCELAR</Btn>
          <Btn onClick={extraer} disabled={loading}>{loading ? "LEYENDO…" : <><Ico e="🤖" className="mr-1" />EXTRAER DATOS</>}</Btn>
        </div>
      </div>}
      {preview && <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.blueMid, marginBottom: 10 }}>La IA encontró <b>{preview.length}</b> cliente(s). Revisa y confirma → irán a <b>{CARTERAS[cartera].nombre}</b>. Si ya existen (por cuenta, teléfono o nombre) solo se actualizan.</div>
        <div style={{ maxHeight: 300, overflowY: "auto", border: `1px solid ${T.border}`, borderRadius: 7, marginBottom: 12 }}>
          {preview.map((r, i) => {
            const RANGO_LBL = { "0-30":"0-30 días", "31-60":"31-60 días", "61-90":"61-90 días", "91+":"91+ días", "coleccion":"colección" };
            const RANGO_COL = { "0-30":"#16a34a", "31-60":"#f59e0b", "61-90":"#f97316", "91+":"#dc2626", "coleccion":"#7c2d12" };
            return <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                {r.nombre || "(sin nombre)"}
                {r.rango
                  ? <span style={{ fontSize: 9, fontWeight: 800, color: "#fff", background: RANGO_COL[r.rango]||"#64748b", borderRadius: 8, padding: "1px 7px" }}><Ico e="⏱" className="mr-1.5" />{RANGO_LBL[r.rango]||r.rango}</span>
                  : <span style={{ fontSize: 9, fontWeight: 800, color: "#b45309", background: "#fef3c7", borderRadius: 8, padding: "1px 7px" }}><Ico e="⚠" className="mr-1.5" />sin atraso leído</span>}
              </div>
              <div style={{ fontSize: 10, color: T.mut }}>{[r.telefono, r.numeroCuenta && "Cta " + r.numeroCuenta, r.ciudad, r.saldo ? "Saldo " + fmt(r.saldo) : "", r.atraso ? "Moroso " + fmt(r.atraso) : "", r.pagoMensual ? "Cuota " + fmt(r.pagoMensual) : ""].filter(Boolean).join(" · ") || "—"}</div>
            </div>
            <button onClick={() => quitarReg(i)} style={{ background: "none", border: "none", color: T.red, cursor: "pointer", fontWeight: 800 }}><Ico e="✕" /></button>
          </div>;
          })}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="ghost" onClick={() => setPreview(null)}>← VOLVER</Btn>
          <Btn onClick={confirmar} disabled={!preview.length}><Ico e="✅" className="mr-1.5" />AGREGAR {preview.length} A {CARTERAS[cartera].corto}</Btn>
        </div>
      </div>}
    </Modal>;
};

const Clientes = ({
  data,
  isMobile,
  onGuardar,
  onEliminar,
  onPago,
  onDeshacer,
  cfg,
  puedeBorrar = true,
  mesKey,
  onPromesa,
  onRomper,
  disponibles,
  onAgregarTodos,
  onImportarIA,
  onFusionarDuplicados,
  onEliminarVarios
}) => {
  const [q, setQ] = useState("");
  const [filtro, setFiltro] = useState("todos");
  const [cart, setCart] = useState("todas");
  const [editar, setEditar] = useState(null);
  const [nuevo, setNuevo] = useState(false);
  const [ia, setIa] = useState(false);
  const [confTodos, setConfTodos] = useState(false);
  const [detalle, setDetalle] = useState(null);
  const [selMode, setSelMode] = useState(false);
  const [selIds, setSelIds] = useState([]); // ids seleccionados para eliminar
  const [pagar, setPagar] = useState(null);
  const [borrar, setBorrar] = useState(null);
  const [promesaDe, setPromesaDe] = useState(null);
  const [llamar, setLlamar] = useState(null);
  const [factura, setFactura] = useState(null);
  // "Al corriente" = verde SIN rango 0-30 · "r030" = clientes con 1 cuota atrasada (rango 0-30)
  const pasaFiltroSem = c => filtro === "todos" ? true
    : filtro === "verde" ? (c.sem.key === "verde" && c.rango !== "0-30")
    : filtro === "r030" ? (c.rango === "0-30")
    : c.sem.key === filtro;
  const vis = data.filter(c => (cart === "todas" || (c.cartera || "dist") === cart) && pasaFiltroSem(c) && (c.nombre + c.ciudad + c.tel + (c.nroCuenta || "")).toLowerCase().includes(q.toLowerCase()));
  const detalleC = detalle ? data.find(c => c.id === detalle) : null;
  return <div>
      <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 10
    }}>
        <H1>Clientes ({data.length})</H1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {disponibles && disponibles.length > 0 && <Btn variant="ghost" onClick={() => setConfTodos(true)}><Plus size={14} /> TODOS ({disponibles.length})</Btn>}
          <Btn variant="ghost" onClick={() => setIa(true)}><Ico e="🤖" className="mr-1.5" />IA</Btn>
          {onFusionarDuplicados && <Btn variant="ghost" onClick={() => { if(confirm("¿Buscar clientes duplicados (misma cuenta, teléfono o nombre) y fusionarlos en uno solo? Los historiales se unen, nada se pierde.")) onFusionarDuplicados(); }}><Ico e="🧹" className="mr-1.5" />DUP</Btn>}
          {onEliminarVarios && <Btn variant="ghost" onClick={() => { setSelMode(p=>!p); setSelIds([]); }}>{selMode?<><Ico e="✕" className="mr-1" />Cancelar</>:<><Ico e="☑" className="mr-1" />Seleccionar</>}</Btn>}
          <Btn onClick={() => setNuevo(true)}><Plus size={14} /> NUEVO</Btn>
        </div>
      </div>
      <CarteraChips value={cart} onChange={setCart} conTodas />
      <div style={{
      position: "relative",
      marginBottom: 10
    }}>
        <Search size={14} style={{
        position: "absolute",
        left: 10,
        top: "50%",
        transform: "translateY(-50%)",
        color: T.mut
      }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por nombre, ciudad, teléfono o cuenta…" style={{
        width: "100%",
        boxSizing: "border-box",
        background: "#fff",
        border: `2px solid ${T.border}`,
        borderRadius: 7,
        color: T.text,
        fontFamily: T.mono,
        fontSize: 13,
        padding: "10px 12px 10px 32px",
        outline: "none"
      }} />
      </div>
      <div style={{
      display: "flex",
      gap: 7,
      marginBottom: 12,
      flexWrap: "wrap"
    }}>
        {[["todos", "Todos"], ["verde", "Al corriente"], ["r030", "0-30d"], ["amarillo", "31-60d"], ["naranja", "61-90d"], ["rojo", "Críticos"]].map(([k, n]) => <button key={k} onClick={() => setFiltro(k)} style={{
        background: filtro === k ? T.blueMid : T.bg,
        border: `1.5px solid ${filtro === k ? T.blueMid : T.border}`,
        color: filtro === k ? "#fff" : "#5a5a5a",
        padding: "5px 12px",
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 20,
        cursor: "pointer",
        fontFamily: T.mono
      }}>{n}</button>)}
      </div>
      {selMode && (
        <div style={{display:"flex",gap:8,alignItems:"center",margin:"10px 0",flexWrap:"wrap"}}>
          <button onClick={()=>setSelIds(selIds.length===vis.length?[]:vis.map(c=>c.id))}
            style={{padding:"8px 14px",borderRadius:10,border:`1.5px solid ${T.blueMid}`,background:"#fff",color:T.blueMid,fontSize:12,fontWeight:800,cursor:"pointer"}}>
            {selIds.length===vis.length?"Quitar todos":"Seleccionar todos"} ({vis.length})</button>
          <button disabled={!selIds.length}
            onClick={()=>{ if(confirm(`¿Eliminar ${selIds.length} cliente(s) de cobranza? Esta acción no se puede deshacer. Después puedes volver a subirlos con la foto.`)){ onEliminarVarios(selIds); setSelIds([]); setSelMode(false); } }}
            style={{padding:"8px 14px",borderRadius:10,border:"none",background:selIds.length?"#dc2626":"#e5e7eb",color:"#fff",fontSize:12,fontWeight:800,cursor:selIds.length?"pointer":"default"}}>
            <Ico e="🗑" className="mr-1.5" />Eliminar ({selIds.length})</button>
        </div>
      )}
      <div>
        {vis.map((c, i) => <div key={c.id} onClick={() => selMode ? setSelIds(p=>p.includes(c.id)?p.filter(x=>x!==c.id):[...p,c.id]) : setDetalle(c.id)} style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 0",
        borderBottom: `1px solid ${T.border}`,
        cursor: "pointer"
      }}>
            {selMode && <div style={{
          width: 20, height: 20, borderRadius: 6, flexShrink: 0,
          border: `2px solid ${selIds.includes(c.id)?"#dc2626":T.border}`,
          background: selIds.includes(c.id)?"#dc2626":"#fff",
          color:"#fff", display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:13, fontWeight:900
        }}>{selIds.includes(c.id)?"✓":""}</div>}
            <div style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: c.sem.color,
          flexShrink: 0
        }} />
            <div style={{
          flex: 1,
          minWidth: 0
        }}>
              <div style={{
            fontSize: 13,
            fontWeight: 700,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis"
          }}>{c.nombre}</div>
              <div style={{
            fontSize: 10,
            color: T.mut
          }}>{c.ciudad} · {c.rango ? `atraso ${c.rango==="coleccion"?"colección":c.rango}` : Number.isFinite(c.dias) ? `${c.dias}d sin pago` : "sin datos"} · {fmt(c.saldo)}</div>
            </div>
            {enRiesgoCesion(c, mesKey) && <span style={{
          fontSize: 8,
          color: T.red,
          fontWeight: 700,
          border: `1.5px solid ${T.red}`,
          borderRadius: 10,
          padding: "2px 6px"
        }}><Ico e="⚠" className="mr-1.5" />CESIÓN</span>}
            <Badge sem={c.sem} />
            <ChevronRight size={14} color={T.mut} />
          </div>)}
        {!vis.length && <div style={{
        color: T.mut,
        fontSize: 12,
        padding: 20,
        textAlign: "center"
      }}>Sin clientes que coincidan con el filtro.</div>}
      </div>

      {confTodos && <Modal title="AGREGAR TODOS" onClose={() => setConfTodos(false)}>
          <p style={{ fontSize: 12, color: T.text, marginBottom: 16 }}>Se agregarán <b>{disponibles.length}</b> clientes de Distribución a Cobranza con saldo en $0. Podrás ponerles saldo y registrar pagos después. ¿Continuar?</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={() => setConfTodos(false)}>Cancelar</Btn>
            <Btn onClick={() => { onAgregarTodos(); setConfTodos(false); }}>Agregar {disponibles.length}</Btn>
          </div>
        </Modal>}
      {ia && <ImportClientesIA onClose={() => setIa(false)} onImportar={(regs, cartera) => {
      onImportarIA(regs, cartera);
      setIa(false);
    }} />}
      {nuevo && <FormCliente disponibles={disponibles} onClose={() => setNuevo(false)} onGuardar={data => {
      onGuardar(data, null);
      setNuevo(false);
    }} />}
      {editar && <FormCliente c={editar} onClose={() => setEditar(null)} onGuardar={data => {
      onGuardar(data, editar.id);
      setEditar(null);
    }} />}
      {pagar && <FormPago c={pagar} onClose={() => setPagar(null)} onPago={(m, met) => {
      onPago(pagar.id, m, met);
      setPagar(null);
    }} />}
      {borrar && <Modal title="CONFIRMAR ELIMINACIÓN" onClose={() => setBorrar(null)}>
          <p style={{
        fontSize: 12,
        color: T.text,
        marginBottom: 16
      }}>Eliminar a <b>{borrar.nombre}</b> borra también su historial. Esta acción no se puede deshacer.</p>
          <div style={{
        display: "flex",
        gap: 8,
        justifyContent: "flex-end"
      }}>
            <Btn variant="ghost" onClick={() => setBorrar(null)}>CANCELAR</Btn>
            <Btn variant="danger" onClick={() => {
          onEliminar(borrar.id);
          setBorrar(null);
          setDetalle(null);
        }}><Trash2 size={13} /> ELIMINAR</Btn>
          </div>
        </Modal>}
      {factura && <FacturaModal c={factura} cfg={cfg} onClose={() => setFactura(null)} />}
      {promesaDe && <PromesaModal c={promesaDe} onSave={(f, h, m) => {
      onPromesa(promesaDe.id, f, h, m);
      setPromesaDe(null);
    }} onClose={() => setPromesaDe(null)} />}
      {llamar && <LlamarModal tel={llamar} cfg={cfg} onClose={() => setLlamar(null)} />}

      {detalleC && <Modal title={detalleC.nombre.toUpperCase() + " · " + fmt(detalleC.saldo)} onClose={() => setDetalle(null)} wide>
          <div style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        marginBottom: 6,
        alignItems: "center"
      }}>
            <Badge sem={detalleC.sem} />
            {detalleC.nivel && <span style={{
          fontSize: 9,
          fontWeight: 700,
          color: +detalleC.nivel >= 7 ? T.red : +detalleC.nivel >= 4 ? T.orange : T.green,
          border: `1.5px solid currentColor`,
          borderRadius: 12,
          padding: "3px 10px"
        }}>NIVEL {detalleC.nivel}</span>}
            {enRiesgoCesion(detalleC, mesKey) && <span style={{
          fontSize: 9,
          fontWeight: 700,
          color: T.red,
          background: "#fdecea",
          border: `1.5px solid ${T.red}`,
          borderRadius: 12,
          padding: "3px 10px"
        }}><Ico e="⚠" className="mr-1.5" />RIESGO DE CESIÓN</span>}
            {detalleC.estado && detalleC.estado !== "Activo" && <span style={{
          fontSize: 9,
          fontWeight: 700,
          color: "#fff",
          background: T.red,
          borderRadius: 12,
          padding: "4px 10px"
        }}>{detalleC.estado.toUpperCase()}{detalleC.cargoVueltaMonto ? " · " + fmt(detalleC.cargoVueltaMonto) : ""}</span>}
          </div>
          <div style={{
        fontSize: 11,
        color: T.mut,
        marginBottom: 6
      }}>{detalleC.nroCuenta ? "Cta " + detalleC.nroCuenta + " · " : ""}{detalleC.direccion ? detalleC.direccion + ", " : ""}{detalleC.ciudad} · {detalleC.tel} · {detalleC.email}</div>
          {detalleC.nota && <div style={{
        fontSize: 11,
        color: "#5a5a5a",
        background: "#fffbe8",
        border: "1px solid #f0e0a0",
        borderRadius: 7,
        padding: "8px 12px",
        marginBottom: 8,
        lineHeight: 1.5
      }}><Ico e="📝" className="mr-1.5" />{detalleC.nota}</div>}
          {detalleC.promesa && <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        fontSize: 11,
        color: T.blueMid,
        background: T.bluePale,
        border: `1px solid ${T.borderHi}`,
        borderRadius: 7,
        padding: "8px 12px",
        marginBottom: 8
      }}>
              <span><Ico e="🤝" /> <b>Prometió pagar:</b> {detalleC.promesa.fecha} a las {detalleC.promesa.hora}{detalleC.promesa.monto ? " · " + fmt(detalleC.promesa.monto) : ""}</span>
              {detalleC.promesa.fecha < todayISO() && <Btn variant="danger" style={{
          padding: "4px 9px",
          fontSize: 9
        }} onClick={() => onRomper(detalleC.id)}><XCircle size={11} /> NO CUMPLIÓ</Btn>}
            </div>}
          <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(3,1fr)",
        gap: 10,
        marginBottom: 16
      }}>
            {[["BALANCE TOTAL", fmt(detalleC.saldo), detalleC.sem.color], ["CUOTA MENSUAL", fmt(detalleC.pagoMensual), T.text], ["DÍAS SIN PAGO", detalleC.dias + "d", detalleC.sem.color]].map(([l, v, col]) => <div key={l} style={{
          background: T.bg,
          border: `1px solid ${T.border}`,
          borderRadius: 7,
          padding: 10
        }}>
                <div style={{
            fontSize: 9,
            color: T.blueMid,
            fontWeight: 700,
            letterSpacing: 1
          }}>{l}</div>
                <div style={{
            fontSize: 15,
            fontWeight: 800,
            color: col
          }}>{v}</div>
              </div>)}
          </div>
          <div style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        marginBottom: 16
      }}>
            <Btn onClick={() => setPagar(detalleC)}><DollarSign size={13} /> PAGO</Btn>
            <Btn variant="ghost" onClick={() => {
          setEditar(detalleC);
          setDetalle(null);
        }}><Edit3 size={13} /> EDITAR</Btn>
            <a href={waLink(detalleC.tel, plantillaLocal(detalleC, detalleC.sem, cfg))} target="_blank" rel="noreferrer" style={{
          textDecoration: "none"
        }}><Btn variant="ghost"><MessageCircle size={13} /> WHATSAPP</Btn></a>
            <a href={smsLink(detalleC.tel, plantillaLocal(detalleC, detalleC.sem, cfg))} style={{
          textDecoration: "none"
        }}><Btn variant="ghost">SMS</Btn></a>
            <Btn variant="ghost" onClick={() => setLlamar(detalleC.tel)}><Phone size={13} /> LLAMAR</Btn>
            <a href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(detalleC.email||"")}&su=${encodeURIComponent("Estado de cuenta — Royal Prestige")}&body=${encodeURIComponent(plantillaLocal(detalleC, detalleC.sem, cfg))}`} target="_blank" rel="noreferrer" style={{
          textDecoration: "none"
        }}><Btn variant="ghost"><Mail size={13} /> GMAIL</Btn></a>
            <Btn onClick={() => setFactura(detalleC)}><FileText size={13} /> FACTURA</Btn>
            <Btn variant="ghost" onClick={() => setPromesaDe(detalleC)}><Ico e="🤝" className="mr-1.5" />PROMESA</Btn>
            {puedeBorrar && <Btn variant="danger" onClick={() => setBorrar(detalleC)}><Trash2 size={13} /></Btn>}
          </div>
          <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center"
      }}>
            <SubT style={{
          margin: 0
        }}>HISTORIAL</SubT>
            {(detalleC.historial || []).some(h => h.tipo === "pago") && <Btn variant="dim" style={{
          padding: "5px 10px",
          fontSize: 10
        }} onClick={() => onDeshacer(detalleC.id)}><Undo2 size={12} /> DESHACER ÚLTIMO PAGO</Btn>}
          </div>
          <div style={{
        marginTop: 10
      }}>
            {(detalleC.historial || []).slice().reverse().map((h, i) => <div key={i} style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          padding: "8px 0",
          borderBottom: `1px solid ${T.border}`
        }}>
                <span style={{
            color: h.tipo === "pago" ? T.text : h.tipo === "promesa" ? T.blueMid : T.red
          }}>{h.tipo === "pago" ? `Pago · ${h.metodo}` : h.tipo === "promesa" ? `🤝 Promesa ${h.metodo}` : <><Ico e="⚠" className="mr-1" />Promesa incumplida</>}</span>
                <span style={{
            color: T.mut
          }}>{h.fecha}{h.tipo === "pago" && <b style={{
              color: T.green,
              marginLeft: 10
            }}>{fmt(h.monto)}</b>}</span>
              </div>)}
            {!(detalleC.historial || []).length && <div style={{
          fontSize: 11,
          color: T.mut
        }}>Sin movimientos aún.</div>}
          </div>
        </Modal>}
    </div>;
};

/* ── Cobranza ── */
const Cobranza = ({
  data,
  resumen,
  cfg,
  onPago,
  isMobile,
  th,
  kpi,
  mesKey,
  onPromesa
}) => {
  const [sesion, setSesion] = useState(null);
  const [cart, setCart] = useState("todas");
  const [factura, setFactura] = useState(null);
  const [promesaDe, setPromesaDe] = useState(null);
  const [llamar, setLlamar] = useState(null);
  const dataF = data.filter(c => cart === "todas" || (c.cartera || "dist") === cart);
  const pendientes = dataF.filter(c => c.sem.key !== "verde");
  const riesgoList = dataF.filter(c => enRiesgoCesion(c, mesKey));
  const salvadas = dataF.filter(c => mesesVencidos(c) >= 2 && pagoEsteMes(c, mesKey));
  const iniciarSesion = async lista => {
    const l = lista || pendientes;
    if (!l.length) return toast("No hay clientes pendientes hoy 🎉");
    const s = {
      lista: l,
      idx: 0,
      msg: "",
      fuente: "",
      cargando: false,
      resultados: []
    };
    setSesion(s);
    cargar(s, 0);
  };
  const cargar = (s, idx) => {
    const c = s.lista[idx];
    setSesion(prev => prev && {
      ...prev,
      idx,
      msg: plantillaLocal(c, c.sem, cfg),
      fuente: "Plantilla " + c.sem.label,
      cargando: false
    });
  };
  const mejorarConIA = async () => {
    const c = sesion.lista[sesion.idx];
    setSesion(prev => ({
      ...prev,
      cargando: true
    }));
    const r = await generarMensajeIA(c, c.sem, cfg);
    setSesion(prev => ({
      ...prev,
      msg: r.texto,
      fuente: r.fuente,
      cargando: false
    }));
  };
  const avanzar = resultado => {
    setSesion(prev => {
      if (!prev) return prev;
      const res = [...prev.resultados, {
        id: prev.lista[prev.idx].id,
        nombre: prev.lista[prev.idx].nombre,
        resultado
      }];
      const next = prev.idx + 1;
      if (next >= prev.lista.length) {
        toast(`Sesión completa: ${res.length} clientes gestionados`);
        return {
          ...prev,
          resultados: res,
          idx: next
        };
      }
      const ns = {
        ...prev,
        resultados: res,
        idx: next,
        cargando: true,
        msg: "",
        fuente: ""
      };
      cargar(ns, next);
      return ns;
    });
  };
  if (sesion) {
    if (sesion.idx >= sesion.lista.length) {
      const cobrados = sesion.resultados.filter(r => r.resultado === "pagó").length;
      return <div>
          <H1>Sesión Completada ✓</H1>
          <Card glow>
            <div style={{
            fontSize: 13,
            marginBottom: 14
          }}>Gestionaste <b style={{
              color: T.green
            }}>{sesion.resultados.length}</b> clientes · <b style={{
              color: T.green
            }}>{cobrados}</b> pagaron en sesión.</div>
            {sesion.resultados.map(r => <div key={r.id} style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 12,
            padding: "8px 0",
            borderBottom: `1px solid ${T.border}`
          }}>
                <span>{r.nombre}</span>
                <span style={{
              color: r.resultado === "pagó" ? T.green : r.resultado === "promesa" ? T.blueMid : r.resultado === "contactado" ? T.yellow : T.mut,
              fontWeight: 700
            }}>{r.resultado.toUpperCase()}</span>
              </div>)}
            <Btn onClick={() => setSesion(null)} style={{
            marginTop: 16
          }}><ChevronLeft size={14} /> VOLVER A COBRANZA</Btn>
          </Card>
        </div>;
    }
    const c = sesion.lista[sesion.idx];
    return <div>
        <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 14
      }}>
          <H1>Cobrar Hoy · {sesion.idx + 1}/{sesion.lista.length}</H1>
          <Btn variant="dim" onClick={() => setSesion(null)} style={{
          padding: "6px 12px",
          fontSize: 10
        }}>SALIR</Btn>
        </div>
        <div style={{
        height: 4,
        background: T.panel2,
        borderRadius: 2,
        marginBottom: 18
      }}>
          <div style={{
          width: `${sesion.idx / sesion.lista.length * 100}%`,
          height: "100%",
          background: T.blueMid,
          borderRadius: 2,
          transition: "width .3s"
        }} />
        </div>
        <Card glow style={{
        borderLeft: `3px solid ${c.sem.color}`
      }}>
          <div style={{
          display: "flex",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8
        }}>
            <div>
              <div style={{
              fontSize: 16,
              fontWeight: 800
            }}>{c.nombre}</div>
              <div style={{
              fontSize: 11,
              color: T.mut,
              marginTop: 3
            }}>{c.ciudad} · {c.tel} · SCORE {c.score}</div>
            </div>
            <Badge sem={c.sem} />
          </div>
          <div style={{
          display: "flex",
          gap: 18,
          margin: "14px 0",
          flexWrap: "wrap"
        }}>
            <span style={{
            fontSize: 12
          }}>SALDO <b style={{
              color: c.sem.color,
              fontSize: 15
            }}>{fmt(c.saldo)}</b></span>
            <span style={{
            fontSize: 12
          }}>SIN PAGO <b style={{
              color: c.sem.color,
              fontSize: 15
            }}>{c.dias}d</b></span>
            <span style={{
            fontSize: 12,
            color: T.mut
          }}>→ {c.sem.accion}</span>
          </div>
          {c.nota && <div style={{
          fontSize: 11,
          color: "#5a5a5a",
          background: "#fffbe8",
          border: "1px solid #f0e0a0",
          borderRadius: 7,
          padding: "8px 12px",
          marginBottom: 12,
          lineHeight: 1.5
        }}><Ico e="📝" className="mr-1.5" />{c.nota}</div>}
          <SubT>MENSAJE SUGERIDO {sesion.fuente && <span style={{
            color: sesion.fuente === "IA" ? T.green : T.orange
          }}>· {sesion.fuente}</span>}</SubT>
          {sesion.cargando ? <div style={{
          color: T.blueMid,
          fontSize: 12,
          fontWeight: 600,
          padding: 16,
          animation: "pulse 1s infinite"
        }}>Generando mensaje…</div> : <textarea value={sesion.msg} onChange={e => setSesion({
          ...sesion,
          msg: e.target.value
        })} rows={5} style={{
          width: "100%",
          boxSizing: "border-box",
          background: "#fff",
          border: `2px solid ${T.border}`,
          borderRadius: 7,
          color: T.text,
          fontFamily: T.mono,
          fontSize: 13,
          padding: 12,
          outline: "none",
          resize: "vertical",
          lineHeight: 1.5
        }} />}
          <div style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginTop: 14
        }}>
            <a href={waLink(c.tel, sesion.msg)} target="_blank" rel="noreferrer" style={{
            textDecoration: "none"
          }}><Btn disabled={sesion.cargando}><MessageCircle size={13} /> WHATSAPP</Btn></a>
            <a href={smsLink(c.tel, sesion.msg)} style={{
            textDecoration: "none"
          }}><Btn variant="ghost" disabled={sesion.cargando}>SMS</Btn></a>
            <Btn variant="ghost" disabled={sesion.cargando} onClick={mejorarConIA} title="Reescribir con IA"><Zap size={13} /> IA</Btn>
            <Btn variant="ghost" disabled={sesion.cargando} onClick={() => {
            navigator.clipboard?.writeText(sesion.msg);
            toast("Mensaje copiado");
          }}>COPIAR</Btn>
            <Btn variant="ghost" onClick={() => setLlamar(c.tel)}><Phone size={13} /></Btn>
            <Btn variant="ghost" onClick={() => setFactura(c)}><FileText size={13} /> FACTURA</Btn>
          </div>
          <div style={{
          borderTop: `1px solid ${T.border}`,
          marginTop: 16,
          paddingTop: 14,
          display: "flex",
          gap: 8,
          flexWrap: "wrap"
        }}>
            <Btn onClick={() => {
            onPago(c.id, c.pagoMensual, "Zelle");
            avanzar("pagó");
          }}><DollarSign size={13} /> PAGÓ {fmt(c.pagoMensual)}</Btn>
            <Btn variant="ghost" onClick={() => setPromesaDe(c)}><Ico e="🤝" className="mr-1.5" />PROMETIÓ</Btn>
            <Btn variant="ghost" onClick={() => avanzar("contactado")}>CONTACTADO →</Btn>
            <Btn variant="dim" onClick={() => avanzar("omitido")}>OMITIR →</Btn>
          </div>
        </Card>
        {factura && <FacturaModal c={factura} cfg={cfg} onClose={() => setFactura(null)} />}
        {promesaDe && <PromesaModal c={promesaDe} onSave={(f, h, m) => {
        onPromesa(promesaDe.id, f, h, m);
        avanzar("promesa");
      }} onClose={() => setPromesaDe(null)} />}
        {llamar && <LlamarModal tel={llamar} cfg={cfg} onClose={() => setLlamar(null)} />}
      </div>;
  }
  const catList = [{
    k: "corriente",
    c: T.green,
    n: "AL CORRIENTE",
    r: "sin atraso",
    filt: c => c.sem.key === "verde" && c.rango !== "0-30"
  }, {
    k: "r030",
    c: "#65a30d",
    n: "ATRASO 0-30",
    r: `0–${th.verde}d`,
    filt: c => c.sem.key === "verde" && c.rango === "0-30"
  }, {
    k: "amarillo",
    c: T.yellow,
    n: "MORA 31-60",
    r: `${th.verde + 1}–${th.amarillo}d`,
    filt: c => c.sem.key === "amarillo"
  }, {
    k: "naranja",
    c: T.orange,
    n: "MORA 61-90",
    r: `${th.amarillo + 1}–${th.naranja}d · ⚠ cesión`,
    filt: c => c.sem.key === "naranja"
  }, {
    k: "rojo",
    c: T.red,
    n: "CRÍTICO 90+",
    r: `${th.naranja + 1}d+ · ⚠ cesión`,
    filt: c => c.sem.key === "rojo"
  }];
  return <div>
      <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 10
    }}>
        <H1>Cobranza</H1>
        <Btn onClick={() => iniciarSesion()}><Zap size={14} /> COBRAR HOY ({pendientes.length})</Btn>
      </div>
      <CarteraChips value={cart} onChange={setCart} conTodas />
      {(riesgoList.length > 0 || salvadas.length > 0) && <Card style={{
      marginBottom: 18,
      border: `2px solid ${T.red}`,
      background: "#fffafa"
    }}>
          <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        flexWrap: "wrap",
        gap: 10,
        marginBottom: riesgoList.length ? 12 : 0
      }}>
            <div>
              <div style={{
            fontFamily: T.serif,
            fontSize: 17,
            fontWeight: 700,
            color: T.red
          }}><Ico e="🚨" className="mr-1.5" />Rescate de Cesiones — {nombreMes(mesKey)}</div>
              <div style={{
            fontSize: 11,
            color: "#5a5a5a",
            marginTop: 3,
            lineHeight: 1.5
          }}>Hy Cite cede toda cuenta con <b>2+ pagos vencidos</b>. <b style={{
              color: T.red
            }}>{riesgoList.length} cuenta(s)</b> — un solo pago las salva.</div>
            </div>
            {riesgoList.length > 0 && <Btn variant="danger" style={{
          background: T.red,
          color: "#fff"
        }} onClick={() => iniciarSesion(riesgoList)}><Zap size={13} /> RESCATE ({riesgoList.length})</Btn>}
          </div>
          {riesgoList.map(c => <div key={c.id} style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 0",
        borderTop: `1px solid #f3d9d6`
      }}>
              <div style={{
          flex: 1,
          minWidth: 0
        }}>
                <span style={{
            fontSize: 12,
            fontWeight: 700
          }}>{c.nombre}</span>
                <span style={{
            fontSize: 10,
            color: T.mut,
            marginLeft: 8
          }}>{mesesVencidos(c)} pagos vencidos · {c.dias}d · {fmt(c.saldo)}</span>
              </div>
              <Btn variant="ghost" style={{
          padding: "5px 8px"
        }} onClick={() => setFactura(c)}><FileText size={12} /></Btn>
              <a href={waLink(c.tel, plantillaLocal(c, c.sem, cfg))} target="_blank" rel="noreferrer" style={{
          textDecoration: "none"
        }}><Btn variant="ghost" style={{
            padding: "5px 8px"
          }}><MessageCircle size={12} /></Btn></a>
            </div>)}
          {salvadas.length > 0 && <div style={{
        marginTop: 10,
        display: "flex",
        gap: 6,
        flexWrap: "wrap"
      }}>
              {salvadas.map(c => <span key={c.id} style={{
          fontSize: 10,
          fontWeight: 700,
          color: T.green,
          background: T.greenDim,
          border: `1.5px solid ${T.green}`,
          borderRadius: 12,
          padding: "3px 10px"
        }}><Ico e="✓" className="mr-1.5" />Salvada: {c.nombre.split(" ")[0]}</span>)}
            </div>}
        </Card>}
      <div style={{
      display: "grid",
      gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(5,1fr)",
      gap: 10,
      marginBottom: 18
    }}>
        {catList.map(x => {
        const arr = dataF.filter(x.filt);
        return <Card key={x.k} style={{
          borderTop: `2px solid ${x.c}`
        }}>
              <div style={{
            fontSize: 9,
            color: x.c,
            fontWeight: 700,
            letterSpacing: 1
          }}>{x.n}</div>
              <div style={{
            fontSize: 9,
            color: T.mut
          }}>{x.r}</div>
              <div style={{
            fontSize: 19,
            fontWeight: 800,
            marginTop: 6
          }}>{arr.length}</div>
              <div style={{
            fontSize: 10,
            color: T.mut
          }}>{fmt(arr.reduce((s, c) => s + c.saldo, 0))}</div>
            </Card>;
      })}
      </div>
      <Card>
        <SubT>LISTA PRIORIZADA POR SCORE</SubT>
        {dataF.map((c, i) => <div key={c.id} style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 0",
        borderBottom: i < dataF.length - 1 ? `1px solid ${T.border}` : "none"
      }}>
            <span style={{
          color: T.mut,
          fontSize: 10,
          width: 22
        }}>{String(i + 1).padStart(2, "0")}</span>
            <div style={{
          flex: 1,
          minWidth: 0
        }}>
              <span style={{
            fontSize: 12,
            fontWeight: 700
          }}>{c.nombre}</span>
              <span style={{
            fontSize: 10,
            color: T.mut,
            marginLeft: 8
          }}>{c.dias}d · {fmt(c.saldo)}</span>
              {enRiesgoCesion(c, mesKey) && <b style={{
            fontSize: 9,
            color: T.red,
            marginLeft: 6
          }}><Ico e="⚠" className="mr-1.5" />CESIÓN</b>}
            </div>
            {!isMobile && <span style={{
          fontSize: 10,
          color: c.sem.color,
          fontWeight: 700
        }}>SCORE {c.score}</span>}
            <Badge sem={c.sem} />
            <a href={waLink(c.tel, plantillaLocal(c, c.sem, cfg))} target="_blank" rel="noreferrer" style={{
          textDecoration: "none"
        }}><Btn variant="ghost" style={{
            padding: "5px 8px"
          }}><MessageCircle size={12} /></Btn></a>
            <Btn variant="ghost" style={{
          padding: "5px 8px"
        }} onClick={() => setFactura(c)}><FileText size={12} /></Btn>
          </div>)}
      </Card>
      {factura && <FacturaModal c={factura} cfg={cfg} onClose={() => setFactura(null)} />}
    </div>;
};

/* ── Recurrentes ── */
const _cargarScript = src => new Promise((resolve, reject) => {
  if (document.querySelector(`script[src="${src}"]`)) return resolve();
  const s = document.createElement("script");
  s.src = src;
  s.onload = () => resolve();
  s.onerror = () => reject(new Error("No se pudo cargar la librería"));
  document.head.appendChild(s);
});
const _digits = s => String(s == null ? "" : s).replace(/\D/g, "");
const _last4 = s => _digits(s).slice(-4);
const _normExp = s => {
  const raw = String(s == null ? "" : s).trim();
  let m = raw.match(/(\d{1,2})\s*[\/\-]\s*(\d{2,4})/);
  if (m) return m[1].padStart(2, "0") + "/" + (m[2].length === 4 ? m[2].slice(2) : m[2]);
  m = raw.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return m[2].padStart(2, "0") + "/" + m[1].slice(2);
  return raw;
};
const _diaDe = s => {
  const raw = String(s == null ? "" : s).trim();
  let m = raw.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return Math.min(28, Math.max(1, +m[3]));
  m = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) return Math.min(28, Math.max(1, +m[1]));
  const n = parseInt(raw, 10);
  return isNaN(n) ? 1 : Math.min(28, Math.max(1, n));
};
const _monto = s => {
  const n = parseFloat(String(s == null ? "" : s).replace(/[^\d.]/g, ""));
  return isNaN(n) ? 0 : n;
};
const ImportAutos = ({
  distribucion,
  onImport,
  onClose
}) => {
  const [modo, setModo] = useState("excel");
  const [filas, setFilas] = useState(null);
  const [leyendo, setLeyendo] = useState(false);
  const fileRef = useRef(null);
  const emparejar = rows => rows.map(r => {
    const ctaR = _digits(r.cuenta);
    const porCuenta = ctaR && distribucion.find(c => _digits(c.cuenta) && _digits(c.cuenta) === ctaR);
    const porNombre = !porCuenta && distribucion.find(c => {
      const parts = String(r.nombre || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
      const nom = String(c.nombre || "").toLowerCase();
      return parts.length >= 1 && nom.includes(parts[0]) && (parts.length < 2 || nom.includes(parts[parts.length - 1]));
    });
    const match = porCuenta || porNombre;
    return {
      nombre: r.nombre || (match ? match.nombre : ""),
      cuenta: r.cuenta || (match ? match.cuenta : ""),
      last4: _last4(r.last4),
      exp: _normExp(r.exp),
      dia: r.dia || 1,
      monto: _monto(r.monto),
      clienteId: match ? String(match.id) : "",
      incluir: true
    };
  });
  const leerExcel = async file => {
    setLeyendo(true);
    try {
      await _cargarScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, {
        type: "array"
      });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = window.XLSX.utils.sheet_to_json(ws, {
        header: 1,
        defval: ""
      });
      if (!aoa.length) {
        toast("La hoja está vacía", "err");
        setLeyendo(false);
        return;
      }
      let hIdx = aoa.findIndex(row => row.filter(x => String(x).trim()).length >= 3);
      if (hIdx < 0) hIdx = 0;
      const headers = aoa[hIdx].map(h => String(h || "").toLowerCase());
      const col = keys => headers.findIndex(h => keys.some(k => h.includes(k)));
      const cN = col(["nombre", "titular", "cliente", "name", "apellido"]);
      const cC = col(["cuenta", "account", "acct", "cta", "hy cite", "hycite"]);
      const cL = col(["últim", "ultim", "last", "dígit", "digit", "tarjeta", "card"]);
      const cE = col(["exp", "venc", "expir"]);
      const cD = col(["cobro", "fecha", "día", "dia", "day", "corte"]);
      const cM = col(["monto", "amount", "valor", "importe", "cuota", "pago", "total"]);
      const rows = [];
      for (let i = hIdx + 1; i < aoa.length; i++) {
        const row = aoa[i];
        if (!row || !row.filter(x => String(x).trim()).length) continue;
        const g = idx => idx >= 0 ? row[idx] : "";
        const nombre = String(g(cN) || "").trim();
        const cuenta = _digits(g(cC));
        if (!nombre && !cuenta) continue;
        rows.push({
          nombre,
          cuenta,
          last4: g(cL),
          exp: g(cE),
          dia: _diaDe(g(cD)),
          monto: g(cM)
        });
      }
      if (!rows.length) {
        toast("No encontré filas con datos. Revisa que la hoja tenga encabezados.", "err");
        setLeyendo(false);
        return;
      }
      setFilas(emparejar(rows));
    } catch (e) {
      toast("No pude leer el archivo: " + (e.message || e), "err");
    }
    setLeyendo(false);
  };
  const leerPDF = file => {
    setLeyendo(true);
    const r = new FileReader();
    r.onload = async () => {
      try {
        const b64 = String(r.result).split(",")[1];
        const res = await fetch("/api/anthropic", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            messages: [{
              role: "user",
              content: [{
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: b64
                }
              }, {
                type: "text",
                text: 'Extrae las filas de cobros automáticos de este documento. Devuelve SOLO un arreglo JSON válido, sin texto ni backticks. Cada objeto: {"nombre":"nombre y apellido","cuenta":"número de cuenta solo dígitos","last4":"últimos 4 dígitos de la tarjeta","exp":"MM/AA","dia":día del mes 1-28,"monto":número}. NUNCA incluyas el número completo de la tarjeta ni el CVV: solo los últimos 4 dígitos. Si falta un dato usa "" o 0.'
              }]
            }]
          })
        });
        if (!res.ok) throw new Error("Servidor " + res.status);
        const data = await res.json();
        const txt = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").replace(/```json|```/g, "").trim();
        const arr = JSON.parse(txt);
        if (!Array.isArray(arr) || !arr.length) throw new Error("sin filas");
        setFilas(emparejar(arr));
      } catch (e) {
        toast("No pude leer el PDF con IA. ¿Está activo el proxy /api/anthropic? (" + (e.message || e) + ")", "err");
      }
      setLeyendo(false);
    };
    r.readAsDataURL(file);
  };
  const upd = (i, k, v) => setFilas(filas.map((f, j) => j === i ? {
    ...f,
    [k]: v
  } : f));
  const validos = filas ? filas.filter(f => f.incluir && f.clienteId && /^\d{4}$/.test(f.last4)).length : 0;
  const confirmar = () => {
    if (!filas) return;
    const listos = filas.filter(f => f.incluir && f.clienteId && /^\d{4}$/.test(f.last4));
    if (!listos.length) return toast("Empareja al menos una fila (cliente + últimos 4 válidos)", "err");
    onImport(listos.map(f => ({
      clienteId: f.clienteId,
      nombre: f.nombre,
      cuenta: f.cuenta,
      last4: f.last4,
      exp: f.exp,
      dia: +f.dia || 1,
      monto: _monto(f.monto)
    })));
    toast(`${listos.length} pago(s) automático(s) importado(s) ✓`);
    onClose();
  };
  const inpS = {
    width: "100%",
    boxSizing: "border-box",
    background: "#fff",
    border: `1.5px solid ${T.border}`,
    borderRadius: 6,
    color: T.text,
    fontFamily: T.mono,
    fontSize: 12,
    fontWeight: 600,
    padding: "6px 8px",
    outline: "none"
  };
  return <Modal title="IMPORTAR PAGOS AUTOMÁTICOS" onClose={onClose} wide>
      {!filas ? <div>
          <div style={{
        display: "flex",
        gap: 7,
        marginBottom: 14
      }}>
            {[["excel", "📊 Excel / CSV"], ["pdf", "📄 PDF (IA)"]].map(([k, n]) => <button key={k} onClick={() => setModo(k)} style={{
          background: modo === k ? T.blueMid : T.bg,
          border: `1.5px solid ${modo === k ? T.blueMid : T.border}`,
          color: modo === k ? "#fff" : "#5a5a5a",
          padding: "7px 14px",
          fontSize: 12,
          fontWeight: 600,
          borderRadius: 20,
          cursor: "pointer",
          fontFamily: T.mono
        }}>{n}</button>)}
          </div>
          <input ref={fileRef} type="file" accept={modo === "excel" ? ".xlsx,.xls,.csv" : "application/pdf"} style={{
        display: "none"
      }} onChange={e => {
        const f = e.target.files && e.target.files[0];
        if (f) modo === "excel" ? leerExcel(f) : leerPDF(f);
        e.target.value = "";
      }} />
          <button onClick={() => fileRef.current && fileRef.current.click()} disabled={leyendo} style={{
        width: "100%",
        boxSizing: "border-box",
        background: T.bluePale,
        border: `2px dashed ${T.blueMid}`,
        borderRadius: 8,
        padding: 22,
        cursor: leyendo ? "wait" : "pointer",
        fontFamily: T.mono,
        color: T.blueMid,
        fontSize: 13,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8
      }}>
            <Upload size={16} /> {leyendo ? "LEYENDO…" : modo === "excel" ? "SUBIR EXCEL O CSV" : "SUBIR PDF (lo lee la IA)"}
          </button>
          <div style={{
        fontSize: 10,
        color: T.mut,
        marginTop: 12,
        lineHeight: 1.6
      }}>
            Columnas esperadas: <b>nombre y apellido</b>, <b>número de cuenta</b>, <b>últimos 4 dígitos</b>, <b>expiración</b>, <b>fecha de cobro</b> y <b>monto</b>. Se empareja por número de cuenta; si coincide, el cliente se agrega a cobranza. 🔒 Nunca se guarda el número completo ni el CVV.
          </div>
        </div> : <div>
          <div style={{
        fontSize: 11,
        color: T.mut,
        marginBottom: 10
      }}>Revisa y empareja. Solo se importan las filas marcadas y con cliente asignado.</div>
          <div style={{
        maxHeight: 340,
        overflowY: "auto",
        border: `1px solid ${T.border}`,
        borderRadius: 7
      }}>
            {filas.map((f, i) => {
          const ok = f.clienteId && /^\d{4}$/.test(f.last4);
          return <div key={i} style={{
            padding: "10px 12px",
            borderBottom: `1px solid ${T.border}`,
            background: f.incluir ? ok ? "#fff" : "#fff8f0" : "#f4f4f4"
          }}>
                  <div style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 6
            }}>
                    <input type="checkbox" checked={f.incluir} onChange={e => upd(i, "incluir", e.target.checked)} />
                    <div style={{
                fontSize: 12,
                fontWeight: 700,
                color: T.text,
                flex: 1
              }}>{f.nombre || "(sin nombre)"}{f.cuenta && <span style={{
                  color: T.mut,
                  fontWeight: 500
                }}> · Cta {f.cuenta}</span>}</div>
                    {ok ? <span style={{
                fontSize: 9,
                color: T.green,
                fontWeight: 700
              }}><Ico e="✓" className="mr-1.5" />match</span> : <span style={{
                fontSize: 9,
                color: T.orange,
                fontWeight: 700
              }}><Ico e="⚠" className="mr-1.5" />revisar</span>}
                  </div>
                  <div style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 1fr 0.7fr 1fr",
              gap: 6
            }}>
                    <select value={f.clienteId} onChange={e => upd(i, "clienteId", e.target.value)} style={inpS}>
                      <option value="">— Sin cliente —</option>
                      {distribucion.map(c => <option key={c.id} value={String(c.id)}>{c.nombre}{c.cuenta ? " · " + c.cuenta : ""}</option>)}
                    </select>
                    <input value={f.last4} onChange={e => upd(i, "last4", e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="últ. 4" style={inpS} />
                    <input value={f.exp} onChange={e => upd(i, "exp", e.target.value)} placeholder="MM/AA" style={inpS} />
                    <input value={f.dia} onChange={e => upd(i, "dia", e.target.value.replace(/\D/g, ""))} placeholder="día" style={inpS} />
                    <input value={f.monto} onChange={e => upd(i, "monto", e.target.value)} placeholder="$ monto" style={inpS} />
                  </div>
                </div>;
        })}
          </div>
          <div style={{
        display: "flex",
        gap: 10,
        marginTop: 14
      }}>
            <Btn variant="ghost" onClick={() => setFilas(null)}><ChevronLeft size={13} /> ATRÁS</Btn>
            <Btn onClick={confirmar} style={{
          flex: 1,
          justifyContent: "center"
        }}><CheckCircle2 size={14} /> IMPORTAR {validos} PAGO(S)</Btn>
          </div>
        </div>}
    </Modal>;
};
const Recurrentes = ({
  recurrentes,
  setRecurrentes,
  clientes,
  isMobile,
  distribucion,
  onImport
}) => {
  const [nuevo, setNuevo] = useState(false);
  const [imp, setImp] = useState(false);
  const [hora, setHora] = useState(new Date().getHours());
  useEffect(() => {
    const i = setInterval(() => setHora(new Date().getHours()), 60000);
    return () => clearInterval(i);
  }, []);
  const hoyDia = new Date().getDate();
  const cobrosHoy = recurrentes.filter(r => r.activo && r.dia === hoyDia);
  const nombreDe = id => clientes.find(c => String(c.id) === String(id))?.nombre || "—";
  return <div>
      <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 10
    }}>
        <H1>Pagos Automáticos</H1>
        <div style={{
        display: "flex",
        gap: 8
      }}><Btn variant="ghost" onClick={() => setImp(true)}><Upload size={14} /> IMPORTAR</Btn><Btn onClick={() => setNuevo(true)}><Plus size={14} /> AGREGAR</Btn></div>
      </div>
      {hora >= 13 && cobrosHoy.length > 0 && <div style={{
      display: "flex",
      gap: 10,
      alignItems: "center",
      background: "#fdecea",
      border: `1px solid ${T.red}`,
      borderRadius: 7,
      padding: "10px 14px",
      marginBottom: 14,
      fontSize: 12,
      color: T.red
    }}>
          <Clock size={15} /> Recordatorio 1PM: hoy toca procesar {cobrosHoy.length} pago(s) — {cobrosHoy.map(r => nombreDe(r.clienteId)).join(", ")}
        </div>}
      <div style={{
      display: "flex",
      gap: 10,
      alignItems: "flex-start",
      background: T.bluePale,
      border: `1px solid ${T.borderHi}`,
      borderRadius: 7,
      padding: "12px 14px",
      marginBottom: 16,
      fontSize: 11,
      color: "#5a5a5a",
      lineHeight: 1.6
    }}>
        <Shield size={16} color={T.green} style={{
        flexShrink: 0,
        marginTop: 1
      }} />
        <span><b style={{
          color: T.blue
        }}>Seguridad:</b> solo se guardan los <b>últimos 4 dígitos</b> y la expiración. Nunca el número completo ni el CVV.</span>
      </div>
      <div style={{
      display: "grid",
      gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
      gap: 10
    }}>
        {recurrentes.map(r => <Card key={r.id} style={{
        opacity: r.activo ? 1 : 0.55
      }}>
            <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start"
        }}>
              <div>
                <div style={{
              fontSize: 13,
              fontWeight: 700
            }}>{nombreDe(r.clienteId)}</div>
                <div style={{
              fontSize: 11,
              color: T.mut,
              marginTop: 4
            }}><CreditCard size={11} style={{
                verticalAlign: -1
              }} /> {maskCard(r.last4)} · exp {r.exp}{!validExp(r.exp) && <span style={{
                color: T.red
              }}> <Ico e="⚠" className="mr-1.5" />VENCIDA</span>}</div>
              </div>
              <button onClick={() => setRecurrentes(rs => rs.map(x => x.id === r.id ? {
            ...x,
            activo: !x.activo
          } : x))} style={{
            background: r.activo ? T.greenDim : T.panel2,
            border: `1.5px solid ${r.activo ? T.green : T.border}`,
            borderRadius: 12,
            color: r.activo ? T.green : T.mut,
            fontFamily: T.mono,
            fontSize: 9,
            fontWeight: 700,
            padding: "4px 8px",
            cursor: "pointer"
          }}>{r.activo ? "ACTIVO" : "PAUSADO"}</button>
            </div>
            <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 12
        }}>
              <span style={{
            fontSize: 11,
            color: T.mut
          }}><Calendar size={11} style={{
              verticalAlign: -1
            }} /> Día {r.dia} de cada mes</span>
              <span style={{
            fontSize: 15,
            fontWeight: 800,
            color: T.green
          }}>{fmt(r.monto)}</span>
            </div>
            <Btn variant="danger" style={{
          marginTop: 12,
          padding: "5px 10px",
          fontSize: 10
        }} onClick={() => {
          setRecurrentes(rs => rs.filter(x => x.id !== r.id));
          toast("Pago automático eliminado");
        }}><Trash2 size={11} /> ELIMINAR</Btn>
          </Card>)}
      </div>
      {!recurrentes.length && <Card><div style={{
        color: T.mut,
        fontSize: 12,
        textAlign: "center",
        padding: 12
      }}>Sin pagos automáticos. Agrega el primero con AGREGAR.</div></Card>}
      {nuevo && <FormRecurrente clientes={clientes} onClose={() => setNuevo(false)} onGuardar={r => {
      setRecurrentes(rs => [...rs, {
        ...r,
        id: Date.now(),
        activo: true
      }]);
      setNuevo(false);
      toast("Pago automático creado");
    }} />}
      {imp && <ImportAutos distribucion={distribucion} onImport={onImport} onClose={() => setImp(false)} />}
    </div>;
};
const FormRecurrente = ({
  clientes,
  onClose,
  onGuardar
}) => {
  const [f, setF] = useState({
    clienteId: clientes[0]?.id || "",
    dia: 1,
    monto: "",
    last4: "",
    exp: ""
  });
  const [errs, setErrs] = useState({});
  const guardar = () => {
    const e = {};
    if (isNaN(+f.monto) || +f.monto <= 0) e.monto = "Monto válido requerido";
    if (!/^\d{4}$/.test(f.last4)) e.last4 = "Solo los últimos 4 dígitos";
    if (!validExp(f.exp)) e.exp = "MM/AA vigente, ej. 09/27";
    if (+f.dia < 1 || +f.dia > 28) e.dia = "Usa día 1–28";
    setErrs(e);
    if (Object.keys(e).length) return;
    onGuardar({
      ...f,
      clienteId: +f.clienteId,
      dia: +f.dia,
      monto: +f.monto
    });
  };
  return <Modal title="NUEVO PAGO AUTOMÁTICO" onClose={onClose}>
      <label style={{
      display: "block",
      marginBottom: 12
    }}>
        <span style={{
        fontSize: 10,
        color: T.mut,
        letterSpacing: 1,
        textTransform: "uppercase"
      }}>CLIENTE</span>
        <select value={f.clienteId} onChange={e => setF({
        ...f,
        clienteId: e.target.value
      })} style={{
        width: "100%",
        marginTop: 4,
        background: "#fff",
        border: `2px solid ${T.border}`,
        borderRadius: 7,
        color: T.text,
        fontFamily: T.mono,
        fontSize: 14,
        fontWeight: 600,
        padding: "10px 12px"
      }}>
          {clientes.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
      </label>
      <div style={{
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 10
    }}>
        <Input label="Día del mes (1–28)" type="number" value={f.dia} onChange={e => setF({
        ...f,
        dia: e.target.value
      })} error={errs.dia} />
        <Input label="Monto ($)" type="number" value={f.monto} onChange={e => setF({
        ...f,
        monto: e.target.value
      })} error={errs.monto} />
      </div>
      <div style={{
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 10
    }}>
        <Input label="Últimos 4 de la tarjeta" maxLength={4} value={f.last4} onChange={e => setF({
        ...f,
        last4: e.target.value.replace(/\D/g, "")
      })} error={errs.last4} placeholder="4242" />
        <Input label="Expiración (MM/AA)" maxLength={5} value={f.exp} onChange={e => {
        let v = e.target.value.replace(/[^\d]/g, "");
        if (v.length > 2) v = v.slice(0, 2) + "/" + v.slice(2, 4);
        setF({
          ...f,
          exp: v
        });
      }} error={errs.exp} placeholder="09/27" />
      </div>
      <div style={{
      fontSize: 10,
      color: T.mut,
      marginBottom: 14
    }}><Ico e="🔒" className="mr-1.5" />Por seguridad no se captura número completo ni CVV.</div>
      <Btn onClick={guardar} style={{
      width: "100%",
      justifyContent: "center"
    }}><CheckCircle2 size={14} /> CREAR</Btn>
    </Modal>;
};

/* ── Reportes ── */
const Reportes = ({
  data,
  recurrentes,
  clientes,
  resumen
}) => {
  const expCartera = () => csvDownload(`cartera-${todayISO()}.csv`, [["Cliente", "Nro Cuenta", "Nivel", "Cartera", "Ciudad", "Teléfono", "Valor pendiente", "Cuota", "Días sin pago", "Estado", "Score"], ...data.map(c => [c.nombre, c.nroCuenta || "", c.nivel || "", CARTERAS[c.cartera || "dist"].nombre, c.ciudad, c.tel, c.saldo, c.pagoMensual, c.dias, c.sem.label, c.score])]);
  const expPagos = () => csvDownload(`pagos-${todayISO()}.csv`, [["Fecha", "Cliente", "Monto", "Método"], ...clientes.flatMap(c => (c.historial || []).filter(h => h.tipo === "pago").map(h => [h.fecha, c.nombre, h.monto, h.metodo])).sort((a, b) => a[0] < b[0] ? 1 : -1)]);
  const expRec = () => csvDownload(`pagos-automaticos-${todayISO()}.csv`, [["Cliente", "Día", "Monto", "Tarjeta", "Expiración", "Estado"], ...recurrentes.map(r => [clientes.find(c => c.id === r.clienteId)?.nombre || "—", r.dia, r.monto, maskCard(r.last4), r.exp, r.activo ? "Activo" : "Pausado"])]);
  // Reporte a la mano: clientes atrasados agrupados por rango de mora
  const RANGOS_REP = [
    { n: "Atraso 0-30", e: "🟢", filt: c => c.sem.key === "verde" && c.rango === "0-30" },
    { n: "Mora 31-60", e: "🟡", filt: c => c.sem.key === "amarillo" },
    { n: "Mora 61-90", e: "🟠", filt: c => c.sem.key === "naranja" },
    { n: "Crítico 90+", e: "🔴", filt: c => c.sem.key === "rojo" }
  ];
  const COLS_ATRASO = ["Cliente", "Nro Cuenta", "Nivel", "Cartera", "Ciudad", "Teléfono", "Valor pendiente", "Cuota", "Días sin pago", "Rango"];
  const filaAtraso = c => [c.nombre, c.nroCuenta || "", c.nivel || "", CARTERAS[c.cartera || "dist"].nombre, c.ciudad, c.tel, c.saldo, c.pagoMensual, c.dias, c.sem.label];
  const expAtraso = (nombre, lista) => csvDownload(`atrasados-${nombre.replace(/\s+/g, "-").toLowerCase()}-${todayISO()}.csv`, [COLS_ATRASO, ...lista.map(filaAtraso)]);
  const todosAtrasados = data.filter(c => RANGOS_REP.some(r => r.filt(c)));
  return <div>
      <H1>Reportes</H1>
      <Card style={{ marginBottom: 18 }}>
        <SubT>CLIENTES ATRASADOS · POR RANGO</SubT>
        {RANGOS_REP.map(r => {
        const lista = data.filter(r.filt);
        return <div key={r.n} style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "9px 0",
          borderBottom: `1px solid ${T.border}`
        }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>{r.e} {r.n}</div>
            <div style={{ fontSize: 11, color: T.mut }}>{lista.length} cliente(s) · {fmt(lista.reduce((s, c) => s + (+c.saldo || 0), 0))}</div>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn variant="ghost" onClick={() => expAtraso(r.n, lista)} disabled={!lista.length} style={{ padding: "5px 8px", fontSize: 10 }}><Download size={12} /> CSV</Btn>
              <Btn variant="ghost" onClick={() => pdfPrint(`Clientes atrasados — ${r.n}`, COLS_ATRASO, lista.map(filaAtraso))} disabled={!lista.length} style={{ padding: "5px 8px", fontSize: 10 }}><Ico e="🖨" className="mr-1.5" />PDF</Btn>
            </div>
          </div>;
      })}
        <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "11px 0 2px"
      }}>
          <div style={{ fontSize: 12, fontWeight: 800 }}><Ico e="📋" className="mr-1.5" />TODOS LOS ATRASADOS</div>
          <div style={{ fontSize: 11, color: T.mut, fontWeight: 700 }}>{todosAtrasados.length} cliente(s) · {fmt(todosAtrasados.reduce((s, c) => s + (+c.saldo || 0), 0))}</div>
          <div style={{ display: "flex", gap: 6 }}>
            <Btn onClick={() => expAtraso("todos", todosAtrasados)} disabled={!todosAtrasados.length} style={{ padding: "5px 8px", fontSize: 10 }}><Download size={12} /> CSV</Btn>
            <Btn onClick={() => pdfPrint("Clientes atrasados — Todos", COLS_ATRASO, todosAtrasados.map(filaAtraso))} disabled={!todosAtrasados.length} style={{ padding: "5px 8px", fontSize: 10 }}><Ico e="🖨" className="mr-1.5" />PDF</Btn>
          </div>
        </div>
      </Card>
      <Card>
        <SubT>EXPORTAR (CSV → ABRE EN EXCEL)</SubT>
        <div style={{
        display: "flex",
        gap: 10,
        flexWrap: "wrap"
      }}>
          <Btn variant="ghost" onClick={expCartera}><Download size={13} /> CARTERA COMPLETA</Btn>
          <Btn variant="ghost" onClick={() => pdfPrint("Cartera completa", ["Cliente", "Nro Cuenta", "Nivel", "Cartera", "Ciudad", "Teléfono", "Valor pendiente", "Cuota", "Días sin pago", "Estado"], data.map(c => [c.nombre, c.nroCuenta || "", c.nivel || "", CARTERAS[c.cartera || "dist"].nombre, c.ciudad, c.tel, c.saldo, c.pagoMensual, c.dias, c.sem.label]))}><Ico e="🖨" className="mr-1.5" />CARTERA PDF</Btn>
          <Btn variant="ghost" onClick={expPagos}><Download size={13} /> HISTORIAL DE PAGOS</Btn>
          <Btn variant="ghost" onClick={() => pdfPrint("Historial de pagos", ["Fecha", "Cliente", "Monto", "Método"], clientes.flatMap(c => (c.historial || []).filter(h => h.tipo === "pago").map(h => [h.fecha, c.nombre, h.monto, h.metodo])).sort((a, b) => a[0] < b[0] ? 1 : -1))}><Ico e="🖨" className="mr-1.5" />PAGOS PDF</Btn>
          <Btn variant="ghost" onClick={expRec}><Download size={13} /> PAGOS AUTOMÁTICOS</Btn>
        </div>
        <div style={{
        fontSize: 10,
        color: T.mut,
        marginTop: 12
      }}>Los CSV abren directo en Excel y conservan acentos (UTF-8 BOM).</div>
      </Card>
    </div>;
};

/* ── Config ── */
const Config = ({
  cfg,
  setCfg,
  onBackup,
  onRestore,
  onReset
}) => {
  const [f, setF] = useState({
    ...cfg
  });
  const fileRef = useRef(null);
  const guardar = () => {
    const t = f.thresholds;
    if (!(t.verde > 0 && t.amarillo > t.verde && t.naranja > t.amarillo)) return toast("Umbrales: verde < amarillo < naranja", "err");
    setCfg(f);
    toast("Configuración guardada");
  };
  return <div>
      <H1>Configuración</H1>
      <Card style={{
      marginBottom: 14
    }}>
        <SubT>NEGOCIO</SubT>
        <Input label="Nombre del distribuidor (sale en mensajes y facturas)" value={f.usuario || ""} onChange={e => setF({
        ...f,
        usuario: e.target.value
      })} placeholder="Impact Enterprises" />
      </Card>
      <Card style={{
      marginBottom: 14
    }}>
        <SubT>UMBRALES DEL SEMÁFORO (DÍAS SIN PAGO)</SubT>
        <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 10
      }}>
          <Input label="🟢 hasta" type="number" value={f.thresholds.verde} onChange={e => setF({
          ...f,
          thresholds: {
            ...f.thresholds,
            verde: +e.target.value
          }
        })} />
          <Input label="🟡 hasta" type="number" value={f.thresholds.amarillo} onChange={e => setF({
          ...f,
          thresholds: {
            ...f.thresholds,
            amarillo: +e.target.value
          }
        })} />
          <Input label="🟠 hasta" type="number" value={f.thresholds.naranja} onChange={e => setF({
          ...f,
          thresholds: {
            ...f.thresholds,
            naranja: +e.target.value
          }
        })} />
        </div>
        <div style={{
        fontSize: 10,
        color: T.mut
      }}>Alineados a los buckets de Hy Cite: 0-30 / 31-60 / 61-90 / 🔴 90+.</div>
      </Card>
      <Card style={{
      marginBottom: 14
    }}>
        <SubT>FORMAS DE PAGO (SALEN EN FACTURAS Y MENSAJES)</SubT>
        <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 10
      }}>
          <Input label="Zelle (tel o email)" value={f.zelle || ""} onChange={e => setF({
          ...f,
          zelle: e.target.value
        })} placeholder="(254) 555-0100" />
          <Input label="Titular del Zelle" value={f.zelleTitular || ""} onChange={e => setF({
          ...f,
          zelleTitular: e.target.value
        })} placeholder="Tomás Flores" />
        </div>
        <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 10
      }}>
          <Input label="Cash App ($cashtag)" value={f.cashapp || ""} onChange={e => setF({
          ...f,
          cashapp: e.target.value
        })} placeholder="$ImpactEnterprises" />
          <Input label="Titular del Cash App" value={f.cashappTitular || ""} onChange={e => setF({
          ...f,
          cashappTitular: e.target.value
        })} placeholder="Tomás Flores" />
        </div>
        <Input label="Teléfono de contacto (sale en la factura)" value={f.telDistribuidor || ""} onChange={e => setF({
        ...f,
        telDistribuidor: e.target.value
      })} placeholder="(254) 555-0100" />
      </Card>
      <Card style={{
      marginBottom: 14
    }}>
        <SubT>WHATSAPP (ULTRAMSG · OPCIONAL)</SubT>
        <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 10
      }}>
          <Input label="Instance ID" value={f.ultramsgInstance || ""} onChange={e => setF({
          ...f,
          ultramsgInstance: e.target.value
        })} placeholder="instance12345" />
          <Input label="Token" value={f.ultramsgToken || ""} onChange={e => setF({
          ...f,
          ultramsgToken: e.target.value
        })} placeholder="token…" />
        </div>
        <div style={{
        fontSize: 10,
        color: T.mut,
        lineHeight: 1.6
      }}>Si lo dejas vacío, los mensajes se abren en WhatsApp con el texto ya escrito, listo para enviar (wa.me).</div>
      </Card>
      <Card style={{
      marginBottom: 14
    }}>
        <SubT>CRM DE TELEMARKETING</SubT>
        <Input label="URL del CRM para marcar" value={f.crmTelemarketingUrl || ""} onChange={e => setF({
        ...f,
        crmTelemarketingUrl: e.target.value
      })} placeholder="https://mi-crm.replit.app/llamar?num={tel}" />
        <div style={{
        fontSize: 10,
        color: T.mut,
        lineHeight: 1.6
      }}>Usa <b>{`{tel}`}</b> para número con código de país o <b>{`{tel10}`}</b> para 10 dígitos.</div>
      </Card>
      <Card style={{
      marginBottom: 14
    }}>
        <SubT>PLANTILLAS DE COBRANZA</SubT>
        <div style={{
        fontSize: 10,
        color: T.mut,
        marginBottom: 12,
        lineHeight: 1.6
      }}>Variables: <b>{`{nombre}`} {`{saldo}`} {`{cuota}`} {`{dias}`} {`{usuario}`} {`{pago}`}</b></div>
        {[["verde", "🟢 MORA 0-30 (1 mes de atraso)"], ["amarillo", "🟡 MORA 31-60"], ["naranja", "🟠 MORA 61-90"], ["rojo", "🔴 CRÍTICO 90+"]].map(([k, n]) => <div key={k} style={{
        marginBottom: 12
      }}>
            <div style={{
          fontSize: 10,
          color: T.blueMid,
          fontWeight: 700,
          marginBottom: 4
        }}>{n}</div>
            <textarea value={(f.plantillas || PLANTILLAS_DEFAULT)[k]} onChange={e => setF({
          ...f,
          plantillas: {
            ...(f.plantillas || PLANTILLAS_DEFAULT),
            [k]: e.target.value
          }
        })} rows={3} style={{
          width: "100%",
          boxSizing: "border-box",
          background: "#fff",
          border: `2px solid ${T.border}`,
          borderRadius: 7,
          color: T.text,
          fontFamily: T.mono,
          fontSize: 11,
          padding: 10,
          outline: "none",
          resize: "vertical",
          lineHeight: 1.5
        }} />
          </div>)}
      </Card>
      <Btn onClick={guardar} style={{
      width: "100%",
      justifyContent: "center",
      marginBottom: 14
    }}><CheckCircle2 size={14} /> GUARDAR CONFIGURACIÓN</Btn>
      <Card>
        <SubT>RESPALDO DE DATOS</SubT>
        <div style={{
        display: "flex",
        gap: 10,
        flexWrap: "wrap"
      }}>
          <Btn variant="ghost" onClick={onBackup}><Download size={13} /> DESCARGAR BACKUP JSON</Btn>
          <Btn variant="ghost" onClick={() => fileRef.current?.click()}><Upload size={13} /> RESTAURAR BACKUP</Btn>
        </div>
        <input ref={fileRef} type="file" accept=".json" style={{
        display: "none"
      }} onChange={e => e.target.files?.[0] && onRestore(e.target.files[0])} />
        <div style={{
        fontSize: 10,
        color: T.mut,
        marginTop: 10
      }}>El backup incluye los datos de cobranza: saldos, historial de pagos y pagos automáticos.</div>
      </Card>
      <Card style={{ borderLeft: `3px solid ${T.red}` }}>
        <SubT>ZONA DE PELIGRO</SubT>
        <div style={{ fontSize: 11, color: T.mut, marginBottom: 10, lineHeight: 1.6 }}>
          Deja TODO el módulo de cobranza en cero: clientes, pagos, reportes, metas del mes, pagos automáticos y pagos externos. La configuración (plantillas, Zelle, umbrales) se conserva. <b>No afecta Telemarketing, Agenda ni las bases de datos.</b> Descarga un backup antes, por si acaso.
        </div>
        <Btn variant="ghost" onClick={() => {
        if (!confirm("⚠️ Esto deja TODA la cobranza en 0: clientes, pagos, reportes y metas. ¿Continuar?")) return;
        if (!confirm("Última confirmación: los datos de cobranza se borrarán en todos los dispositivos. ¿Seguro?")) return;
        onReset && onReset();
      }} style={{ borderColor: T.red, color: T.red }}><Ico e="🧹" className="mr-1.5" />REINICIAR COBRANZA EN 0</Btn>
      </Card>
    </div>;
};
function CobranzaSection({
  distribucion,
  cobranza,
  setCobranza: setCobranzaRaw
}) {
  // Sello de tiempo automático: TODO cambio en un cliente de cobranza queda
  // marcado con _t. El merge protector usa esa marca para que la versión más
  // reciente (incluidos los borrados) gane siempre en la sincronización.
  const setCobranza = fn => setCobranzaRaw(prev => {
    const p = prev || {};
    const next = typeof fn === "function" ? fn(p) : fn;
    if (!next || next.clientesData === p.clientesData) return next;
    const antes = p.clientesData || {};
    const cd = { ...(next.clientesData || {}) };
    let hubo = false;
    Object.keys(cd).forEach(id => {
      const a = antes[id], b = cd[id];
      if (!b) return;
      if (!a || JSON.stringify(a) !== JSON.stringify(b)) { cd[id] = { ...b, _t: Date.now() }; hubo = true; }
    });
    return hubo ? { ...next, clientesData: cd } : next;
  });
  const [tab, setTab] = useState("dashboard");
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" && window.innerWidth < 768);
  useEffect(() => {
    const onR = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onR);
    return () => window.removeEventListener("resize", onR);
  }, []);
  const dist = distribucion || [];
  const cb = cobranza || {};
  const clientesData = cb.clientesData || {};
  const recurrentes = cb.recurrentes || [];
  const pagosExternos = cb.pagosExternos || []; // pagos del recibo diario sin cliente en la app
  const cfg = {
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      ...(cb.cfg && cb.cfg.thresholds)
    },
    plantillas: {
      ...PLANTILLAS_DEFAULT,
      ...(cb.cfg && cb.cfg.plantillas)
    },
    ultramsgInstance: "",
    ultramsgToken: "",
    metaPct: 8,
    zelle: "",
    zelleTitular: "",
    cashapp: "",
    cashappTitular: "",
    telDistribuidor: "",
    crmTelemarketingUrl: "",
    usuario: "",
    ...(cb.cfg || {})
  };
  const meses = cb.meses || {
    [mesKeyHoy()]: {
      dist: 0,
      fin: 0,
      metaPct: 8
    }
  };
  const th = cfg.thresholds;
  const mesKey = mesKeyHoy();
  const mesCfg = meses[mesKey] || null;
  const reportesFin = cb.reportesFin || {};
  const snapsMes = [...(reportesFin[mesKey] || [])].sort((x, y) => x.fecha < y.fecha ? -1 : 1);
  // Pagos registrados en la app DESPUÉS del último reporte → cartera viva
  const pagosDesdeReporte = useMemo(() => {
    const ult = snapsMes[snapsMes.length - 1];
    if (!ult) return 0;
    let t = 0;
    Object.values(clientesData || {}).forEach(c => (c.historial || []).forEach(h => {
      if (h.tipo === "pago" && h.fecha > ult.fecha) t += +h.monto || 0;
    }));
    pagosExternos.forEach(h => { if (h.fecha > ult.fecha) t += +h.monto || 0; });
    return +t.toFixed(2);
  }, [clientesData, snapsMes, pagosExternos]);
  const cfgSesion = {
    ...cfg,
    usuario: cfg.usuario || ""
  };
  const setCfg = fn => setCobranza(prev => {
    const p = prev || {};
    const nc = typeof fn === "function" ? fn({
      ...cfg
    }) : fn;
    return {
      ...p,
      cfg: nc
    };
  });
  const setMeses = fn => setCobranza(prev => {
    const p = prev || {};
    const nm = typeof fn === "function" ? fn(p.meses || meses) : fn;
    return {
      ...p,
      meses: nm
    };
  });
  const setRecurrentes = fn => setCobranza(prev => {
    const p = prev || {};
    const nr = typeof fn === "function" ? fn(p.recurrentes || []) : fn;
    return {
      ...p,
      recurrentes: nr
    };
  });
  const updCliente = (id, fn) => setCobranza(prev => {
    const p = prev || {};
    const cd = {
      ...(p.clientesData || {})
    };
    cd[String(id)] = fn(cd[String(id)] || {});
    return {
      ...p,
      clientesData: cd
    };
  });
  const removeCliente = id => setCobranza(prev => {
    const p = prev || {};
    const cd = {
      ...(p.clientesData || {})
    };
    // LÁPIDA en vez de borrar la clave: si se elimina la clave, cualquier eco de
    // sincronización de otro dispositivo puede "resucitar" al cliente. La marca
    // _oculto sobrevive a las fusiones y además no mueve claves entre fragmentos.
    const cid = String(id);
    if (cd[cid]) cd[cid] = { ...cd[cid], _oculto: true };
    return {
      ...p,
      clientesData: cd,
      recurrentes: (p.recurrentes || []).filter(r => String(r.clienteId) !== cid)
    };
  });
  // Reinicio TOTAL del módulo (para pruebas o empezar de cero). Conserva cfg.
  const reiniciarCobranza = () => {
    setCobranza(prev => ({
      cfg: (prev || {}).cfg || {},
      clientesData: {},
      recurrentes: [],
      reportesFin: {},
      meses: {},
      pagosExternos: []
    }));
    toast("🧹 Cobranza reiniciada en 0 — lista para empezar limpio");
  };
  // Pagos del recibo diario que NO hacen match con ningún cliente de la app:
  // se guardan en un libro aparte y SUMAN al cobrado del mes de todas formas.
  const registrarPagosExternos = rows => setCobranza(prev => {
    const p = prev || {};
    const arr = [...(p.pagosExternos || [])];
    rows.forEach(r => {
      const f = (typeof r.fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.fecha)) ? r.fecha : todayISO();
      arr.push({ fecha: f, nombre: r.nombre || "(sin nombre)", cuenta: String(r.cuenta || ""), monto: +(+r.monto || 0).toFixed(2), origen: "Hy Cite" });
    });
    return { ...p, pagosExternos: arr };
  });
  const idxDist = useMemo(() => {
    const m = {};
    dist.forEach(d => {
      m[String(d.id)] = d;
    });
    return m;
  }, [dist]);
  const clientes = useMemo(() => Object.keys(clientesData).filter(id => !(clientesData[id] || {})._oculto).map(id => {
    const ov = clientesData[id] || {};
    const d = idxDist[id];
    return {
      id,
      nombre: ov.nombre || d && d.nombre || "—",
      tel: ov.tel || d && d.telefono || "",
      nroCuenta: ov.nroCuenta || d && d.cuenta || "",
      ciudad: ov.ciudad || d && d.ciudad || "",
      direccion: ov.direccion || d && d.direccion || "",
      email: ov.email || "",
      saldo: +ov.saldo || 0,
      pagoMensual: +ov.pagoMensual || 0,
      ultimoPago: ov.ultimoPago || "",
      // CAMPOS DE ATRASO del reporte Hy Cite — antes se PERDÍAN aquí: aunque
      // importarClientesIA los guardaba en clientesData, este map los descartaba
      // y por eso el cliente salía "sin datos / Al corriente" en la lista.
      rango: ov.rango || "",
      diasAtraso: (ov.diasAtraso ?? null),
      atraso: +ov.atraso || 0,
      emprendedor: ov.emprendedor || "",
      cuotaEstimada: ov.cuotaEstimada || false,
      historial: ov.historial || [],
      promesa: ov.promesa || null,
      cartera: ov.cartera || "dist",
      nivel: ov.nivel || "",
      tipoCuenta: ov.tipoCuenta || "",
      metodoPago: ov.metodoPago || "",
      estado: ov.estado || "Activo",
      cargoVueltaFecha: ov.cargoVueltaFecha || "",
      cargoVueltaMonto: ov.cargoVueltaMonto || "",
      nota: ov.nota || "",
      referencias: ov.referencias || [],
      _enBase: !!d
    };
  }), [clientesData, idxDist]);
  const disponibles = useMemo(() => dist.filter(d => { const e = clientesData[String(d.id)]; return !e || e._oculto; }).map(d => ({
    id: d.id,
    nombre: d.nombre,
    telefono: d.telefono,
    cuenta: d.cuenta,
    ciudad: d.ciudad,
    direccion: d.direccion
  })), [dist, clientesData]);
  const enriquecidos = useMemo(() => clientes.map(c => {
    const dias = daysSince(c.ultimoPago);
    return {
      ...c,
      dias,
      sem: semDeCliente(c, th), // respeta el rango del reporte Hy Cite si existe
      score: scoreDe(c, th)
    };
  }), [clientes, th]);
  const resumen = useMemo(() => {
    const cats = {
      verde: [],
      amarillo: [],
      naranja: [],
      rojo: []
    };
    enriquecidos.forEach(c => cats[c.sem.key].push(c));
    const total = enriquecidos.reduce((s, c) => s + c.saldo, 0);
    const mes = todayISO().slice(0, 7);
    const cobradoMes = clientes.flatMap(c => c.historial || []).filter(h => h.tipo === "pago" && h.fecha.startsWith(mes)).reduce((s, h) => s + h.monto, 0)
      + pagosExternos.filter(h => h.fecha && h.fecha.startsWith(mes)).reduce((s, h) => s + h.monto, 0);
    const vencido = [...cats.naranja, ...cats.rojo].reduce((s, c) => s + c.saldo, 0);
    return {
      cats,
      total,
      cobradoMes,
      vencido
    };
  }, [enriquecidos, clientes, pagosExternos]);
  const cobradoCartera = useMemo(() => {
    const g = cart => clientes.filter(c => (c.cartera || "dist") === cart).flatMap(c => c.historial || []).filter(h => h.tipo === "pago" && h.fecha.startsWith(mesKey)).reduce((s, h) => s + h.monto, 0);
    const ext = pagosExternos.filter(h => h.fecha && h.fecha.startsWith(mesKey)).reduce((s, h) => s + h.monto, 0);
    return {
      dist: g("dist") + ext,
      fin: g("fin")
    };
  }, [clientes, mesKey, pagosExternos]);
  const prioritarios = useMemo(() => [...enriquecidos].sort((a, b) => b.score - a.score), [enriquecidos]);
  const kpiHyCite = useMemo(() => {
    const riesgo = enriquecidos.filter(c => enRiesgoCesion(c, mesKey));
    const salvadas = enriquecidos.filter(c => mesesVencidos(c) >= 2 && pagoEsteMes(c, mesKey));
    // ── Morosidad: sale DIRECTO del último reporte financiero (Control de
    // Cartera Hy Cite) si existe; así los indicadores se mueven al subir el
    // reporte. Sin reporte, se estima desde los clientes individuales. ──
    const ultRep = snapsMes && snapsMes.length ? snapsMes[snapsMes.length - 1] : null;
    let mora31, moraTotal;
    if (ultRep && ultRep.total && ultRep.total.cxc > 0) {
      const cxc = ultRep.total.cxc;
      const t = ultRep.total;
      moraTotal = (t.d0 + t.d31 + t.d61 + t.d90) / cxc * 100;
      mora31 = (t.d31 + t.d61 + t.d90) / cxc * 100;
    } else {
      const total = clientes.reduce((s, c) => s + c.saldo, 0) || 1;
      let v31 = 0, vTot = 0;
      clientes.forEach(c => {
        const v = montoVencido(c);
        vTot += v;
        if (daysSince(c.ultimoPago) >= 31) v31 += v;
      });
      mora31 = v31 / total * 100;
      moraTotal = vTot / total * 100;
    }
    // Riesgo por atraso: TODO lo que esté a más de 60 días (naranja 61-90 + rojo 90+)
    const atraso60 = enriquecidos.filter(c => c.sem.key === "naranja" || c.sem.key === "rojo");
    return {
      mora31,
      moraTotal,
      desdeReporte: !!ultRep,
      riesgo,
      salvadas,
      saldoRiesgo: riesgo.reduce((s, c) => s + c.saldo, 0),
      atraso60Count: atraso60.length,
      atraso60Saldo: atraso60.reduce((s, c) => s + c.saldo, 0),
      // Cesión SEGÚN EL REPORTE Hy Cite (si el último reporte del mes la trae explícita)
      repCesion: (ultRep && ultRep.cesion && (+ultRep.cesion.cuentas > 0 || +ultRep.cesion.monto > 0)) ? ultRep.cesion : null,
      // Monto en +61 días SEGÚN EL REPORTE (61-90 + Over 90): la cartera en cesión a trabajar el mes
      rep61: ultRep ? +(((+ultRep.total.d61) || 0) + ((+ultRep.total.d90) || 0)).toFixed(2) : null,
      repFecha: ultRep ? (ultRep.fecha || "") : ""
    };
  }, [clientes, enriquecidos, mesKey, snapsMes]);
  const guardarReporteFin = snap => {
    const mk = String(snap.fecha || "").slice(0, 7) || mesKey;
    const esPrimero = !((cb.reportesFin || {})[mk] || []).length;
    setCobranza(prev => {
      const p = prev || {};
      const rf = { ...(p.reportesFin || {}) };
      const arr = (rf[mk] || []).filter(x => x.fecha !== snap.fecha);
      rf[mk] = [...arr, snap].sort((x, y) => x.fecha < y.fecha ? -1 : 1);
      let ms = p.meses || {};
      if (esPrimero) ms = { ...ms, [mk]: { fin: 0, metaPct: 8, ...(ms[mk] || {}), dist: +(+snap.total.cxc).toFixed(2) } };
      return { ...p, reportesFin: rf, meses: ms };
    });
    toast(esPrimero
      ? `Reporte guardado ✓ Cartera inicial de Distribución fijada: ${fmt(snap.total.cxc)}`
      : `Reporte del ${snap.fecha} guardado ✓`);
  };
  const registrarPago = (id, monto, metodo, fecha) => {
    const fechaPago = (typeof fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) ? fecha : todayISO();
    updCliente(id, ov => {
      // El pago MUEVE al cliente de zona de atraso según las cuotas que cubra:
      // 0-30 = 1 cuota · 31-60 = 2 · 61-90 = 3 · 91+ = 4 o más.
      // Si paga todas, queda AL CORRIENTE. Colección NO cambia con pagos (estado especial).
      const RANGO_CUOTAS = { "0-30": 1, "31-60": 2, "61-90": 3, "91+": 4 };
      const CUOTAS_RANGO = { 1: "0-30", 2: "31-60", 3: "61-90" };
      let nuevoRango = ov.rango || "";
      let nuevoAtraso = Math.max(0, +(((+ov.atraso) || 0) - monto).toFixed(2));
      if(RANGO_CUOTAS[ov.rango]){
        const atrasoTotal = (+ov.atraso) || 0;
        const cuota = +ov.pagoMensual > 0 ? +ov.pagoMensual : 0;
        // Si paga el MOROSO COMPLETO (o más), queda al corriente — sin líos de redondeo.
        const pagaTodo = atrasoTotal > 0 && (+monto) >= atrasoTotal - 0.01;
        // cuotas que cubre este pago (tolerancia de centavos; mínimo 1; sin cuota conocida = 1)
        const k = cuota > 0 ? Math.max(1, Math.floor((+monto) / cuota + 0.01)) : 1;
        const restantes = pagaTodo ? 0 : RANGO_CUOTAS[ov.rango] - k;
        nuevoRango = restantes <= 0 ? "" : (CUOTAS_RANGO[restantes] || "91+");
        if(restantes <= 0) nuevoAtraso = 0;
      }
      return {
        ...ov,
        saldo: Math.max(0, +((+ov.saldo || 0) - monto).toFixed(2)),
        ultimoPago: fechaPago,
        promesa: null,
        rango: nuevoRango,
        atraso: nuevoAtraso,
        historial: [...(ov.historial || []), {
          fecha: fechaPago,
          monto,
          metodo,
          tipo: "pago",
          // respaldo para poder DESHACER el pago restaurando la zona anterior
          rangoPrev: ov.rango || "",
          atrasoPrev: (+ov.atraso) || 0
        }]
      };
    });
    toast(`Pago de ${fmt(monto)} registrado`);
  };
  const deshacerPago = id => {
    updCliente(id, ov => {
      const h = [...(ov.historial || [])];
      const i = h.map(x => x.tipo).lastIndexOf("pago");
      if (i < 0) return ov;
      const p = h.splice(i, 1)[0];
      const prev = h.filter(x => x.tipo === "pago").slice(-1)[0];
      toast(`Pago de ${fmt(p.monto)} deshecho`);
      return {
        ...ov,
        saldo: +((+ov.saldo || 0) + p.monto).toFixed(2),
        ultimoPago: prev ? prev.fecha : ov.ultimoPago,
        // deshacer también RESTAURA la zona de atraso y el moroso previos
        ...(p.rangoPrev !== undefined ? { rango: p.rangoPrev } : {}),
        ...(p.atrasoPrev !== undefined ? { atraso: p.atrasoPrev } : {}),
        historial: h
      };
    });
  };
  const guardarPromesa = (id, fecha, hora, monto) => {
    updCliente(id, ov => ({
      ...ov,
      promesa: {
        fecha,
        hora,
        monto
      },
      historial: [...(ov.historial || []), {
        fecha: todayISO(),
        monto: monto || 0,
        metodo: `para ${fecha} ${hora}`,
        tipo: "promesa"
      }]
    }));
    toast("Promesa de pago registrada 🤝");
  };
  const romperPromesa = id => {
    updCliente(id, ov => ({
      ...ov,
      promesa: null,
      historial: [...(ov.historial || []), {
        fecha: todayISO(),
        monto: 0,
        metodo: "",
        tipo: "promesa_rota"
      }]
    }));
    toast("Promesa incumplida registrada", "err");
  };
  // Importar clientes extraídos por IA (documentos/fotos) a la cartera elegida.
  // Si el cliente ya existe en Distribución (por cuenta, teléfono o nombre) se enlaza a su id;
  // si no, se crea independiente (útil para MI FINANCIERA). Nunca pisa saldos/historial existentes.
  // Fusiona clientes DUPLICADOS que ya estén en cobranza (misma cuenta, mismo
  // teléfono o mismo nombre normalizado): une historiales, conserva la mejor
  // información y deja UN solo registro por persona.
  const fusionarDuplicadosCobranza = () => {
    const t10 = t => { let d = String(t || "").replace(/\D/g, ""); return d.length > 10 ? d.slice(-10) : d; };
    const nK = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean).sort().join(" ");
    const cK = t => String(t || "").replace(/\W/g, "").toLowerCase();
    let fusionados = 0;
    setCobranza(prev => {
      const p = prev || {};
      const cd = { ...(p.clientesData || {}) };
      const porLlave = {};
      const llaveDe = c => cK(c.numeroCuenta || c.nroCuenta) || t10(c.telefono || c.tel) || nK(c.nombre) || null;
      Object.entries(cd).forEach(([id, c]) => {
        const k = llaveDe(c || {});
        if(!k) return;
        if(!porLlave[k]) porLlave[k] = [];
        porLlave[k].push(id);
      });
      Object.values(porLlave).forEach(ids => {
        if(ids.length < 2) return;
        // principal: el que tenga MÁS historial (empate: más campos llenos)
        ids.sort((a, b) => ((cd[b].historial||[]).length - (cd[a].historial||[]).length) || (Object.values(cd[b]).filter(Boolean).length - Object.values(cd[a]).filter(Boolean).length));
        const base = { ...cd[ids[0]] };
        for(let i = 1; i < ids.length; i++){
          const otro = cd[ids[i]];
          Object.keys(otro || {}).forEach(k2 => { if(base[k2] === undefined || base[k2] === "" || base[k2] === 0) base[k2] = otro[k2]; });
          base.historial = unirHistorial(base.historial, otro.historial);
          if(otro.promesa && !base.promesa) base.promesa = otro.promesa;
          delete cd[ids[i]];
          fusionados++;
        }
        cd[ids[0]] = base;
      });
      return { ...p, clientesData: cd };
    });
    setTimeout(() => toast(fusionados ? `🧹 ${fusionados} duplicado(s) fusionado(s) — historiales unidos` : "Sin duplicados que fusionar ✓"), 50);
  };
  // Eliminar VARIOS clientes de una (selección múltiple)
  const eliminarVariosClientes = (ids) => {
    if(!ids || !ids.length) return;
    setCobranza(prev => {
      const cd = { ...(prev?.clientesData || {}) };
      ids.forEach(id => { const k = String(id); if (cd[k]) cd[k] = { ...cd[k], _oculto: true }; });
      return { ...prev, clientesData: cd };
    });
    setTimeout(()=>toast(`🗑️ ${ids.length} cliente(s) eliminado(s)`), 50);
  };
  const importarClientesIA = (registros, cartera) => {
    const tel10 = t => { let d = String(t || "").replace(/\D/g, ""); return d.length > 10 ? d.slice(-10) : d; };
    const nCta = t => String(t || "").replace(/\W/g, "").toLowerCase();
    // Llave de nombre robusta: sin acentos, sin puntuación y con las palabras
    // ORDENADAS — "GARCIA, MARIA" y "María García" producen la misma llave.
    const nNom = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean).sort().join(" ");
    let agregados = 0, actualizados = 0;
    const entradas = [];
    // Índice de los clientes que YA existen en cobranza (por cuenta / teléfono /
    // nombre) para no duplicar cuando el reporte trae el mismo cliente otra vez.
    const idxCob = { cuenta:{}, tel:{}, nom:{} };
    Object.entries(clientesData || {}).forEach(([cid, c]) => {
      if (nCta(c.numeroCuenta || c.cuenta)) idxCob.cuenta[nCta(c.numeroCuenta || c.cuenta)] = cid;
      if (tel10(c.telefono)) idxCob.tel[tel10(c.telefono)] = cid;
      if (nNom(c.nombre)) idxCob.nom[nNom(c.nombre)] = cid;
    });
    // IDs ya asignados EN ESTE MISMO lote → evita duplicar filas repetidas del reporte.
    const enLote = { cuenta:{}, tel:{}, nom:{} };
    const vistos = new Set();
    (registros || []).forEach(r => {
      if (!(r.nombre || "").trim() && !tel10(r.telefono)) return;
      const kCta = nCta(r.numeroCuenta), kTel = tel10(r.telefono), kNom = nNom(r.nombre);
      // 1) ¿ya lo vimos en este mismo reporte? → mismo id, solo se actualiza
      let id = (kCta && enLote.cuenta[kCta]) || (kTel && enLote.tel[kTel]) || (kNom && enLote.nom[kNom]) || null;
      let match = null;
      if (!id) {
        // 2) ¿ya existe en cobranza? (cuenta → teléfono → nombre)
        id = (kCta && idxCob.cuenta[kCta]) || (kTel && idxCob.tel[kTel]) || (kNom && idxCob.nom[kNom]) || null;
        // 3) ¿existe en la base de Distribución? → reusar su id
        if (!id) {
          if (kCta) match = dist.find(d => nCta(d.cuenta) === kCta);
          if (!match && kTel) match = dist.find(d => tel10(d.telefono) === kTel);
          if (!match && kNom) match = dist.find(d => nNom(d.nombre) === kNom);
          id = match ? String(match.id) : genId();
        }
      }
      // registrar el id para las tres llaves (dedup dentro del lote)
      if (kCta) enLote.cuenta[kCta] = id;
      if (kTel) enLote.tel[kTel] = id;
      if (kNom) enLote.nom[kNom] = id;
      if (vistos.has(id)) { /* misma persona, fila repetida: no cuenta doble */ }
      else if (clientesData[id]) { actualizados++; vistos.add(id); }
      else { agregados++; vistos.add(id); }
      entradas.push({ id, r, esNuevoEnBase: !match && !clientesData[id] });
    });
    if (!entradas.length) { toast("No hay registros válidos para agregar", "err"); return; }
    setCobranza(prev => {
      const p = prev || {};
      const cd = { ...(p.clientesData || {}) };
      entradas.forEach(({ id, r, esNuevoEnBase }) => {
        const ov = cd[id] || {};
        // Rango final: el que dijo la IA; si no vino pero sí los DÍAS, se deriva.
        const rangoDeDias = d => { if(d === "" || d === null || d === undefined) return ""; const n = +d; if(!(n >= 0) || isNaN(n)) return ""; if(n <= 30) return "0-30"; if(n <= 60) return "31-60"; if(n <= 90) return "61-90"; return "91+"; };
        const rangoFinal = rangoDeRegistro(r) || rangoDeDias(r.diasAtraso) || ov.rango || "";
        // Foto nueva = información nueva: SIEMPRE actualiza saldo, cuota, último
        // pago y rango. NUNCA toca historial de pagos ni promesas existentes.
        // Si el reporte NO trae la cuota pero sí el monto en atraso + rango,
        // se ESTIMA: 0-30 → cuota ≈ atraso · 31-60 → atraso/2 · 61-90 → atraso/3 · 91+/colección → atraso/4.
        const divisorCuota = { "0-30": 1, "31-60": 2, "61-90": 3, "91+": 4, "coleccion": 4 }[rangoFinal];
        const cuotaEstim = (!( +r.pagoMensual > 0) && +r.atraso > 0 && divisorCuota)
          ? +((+r.atraso) / divisorCuota).toFixed(2) : 0;
        cd[id] = {
          ...ov,
          _oculto: false,
          cartera: ov.cartera || cartera,
          saldo: (r.saldo !== undefined && r.saldo !== "" && !isNaN(+r.saldo)) ? +(+r.saldo).toFixed(2) : (+ov.saldo || 0),
          pagoMensual: (+r.pagoMensual > 0) ? +(+r.pagoMensual).toFixed(2)
            : (cuotaEstim > 0 ? cuotaEstim : (+ov.pagoMensual || 0)),
          cuotaEstimada: (+r.pagoMensual > 0) ? false : (cuotaEstim > 0 ? true : (ov.cuotaEstimada || false)),
          atraso: (+r.atraso > 0) ? +(+r.atraso).toFixed(2) : (ov.atraso || 0),
          // Si el reporte trae RANGO (formato Hy Cite), su única fecha es la del
          // ÚLTIMO PEDIDO — que NO es un pago. En ese caso se descarta cualquier
          // fecha que la IA haya puesto y se conserva la que ya tenía el cliente.
          // El rango de la foto es lo que manda para el atraso.
          ultimoPago: rangoFinal ? (ov.ultimoPago || "") : (r.ultimoPago || ov.ultimoPago || todayISO()),
          rango: rangoFinal,  // ubica al cliente en su zona de atraso (0-30/31-60/61-90/91+) según el reporte
          diasAtraso: (+r.diasAtraso >= 0 && r.diasAtraso !== "") ? +r.diasAtraso : (ov.diasAtraso ?? null),
          emprendedor: r.emprendedor || ov.emprendedor || "",
          email: r.email || ov.email || "",
          historial: ov.historial || [],
          // Identidad: se ACTUALIZA con lo que traiga el reporte (suplantar), pero
          // nunca se borra si el reporte viene vacío. Se guardan en las mismas
          // llaves que usa el índice anti-duplicados (nombre/telefono/numeroCuenta).
          nombre: r.nombre || ov.nombre || "",
          telefono: r.telefono || ov.telefono || ov.tel || "",
          numeroCuenta: r.numeroCuenta || ov.numeroCuenta || ov.nroCuenta || "",
          tel: r.telefono || ov.tel || ov.telefono || "",
          nroCuenta: r.numeroCuenta || ov.nroCuenta || ov.numeroCuenta || "",
          ciudad: r.ciudad || ov.ciudad || "",
          direccion: r.direccion || ov.direccion || ""
        };
      });
      return { ...p, clientesData: cd };
    });
    const conRango = (registros||[]).filter(r=>rangoDeRegistro(r)).length;
    toast(`🤖 IA: ${agregados} agregado(s)` + (actualizados ? ` · ${actualizados} actualizado(s)` : "") + (conRango ? ` · ${conRango} con rango de atraso` : " · ⚠️ sin rango detectado"));
  };
  const guardarCliente = (data, id) => {
    const targetId = id || data._pickId;
    if (!targetId) return;
    const clean = {
      ...data
    };
    delete clean._pickId;
    updCliente(targetId, ov => ({
      ...ov,
      ...clean,
      _oculto: false,
      historial: ov.historial || []
    }));
    toast(id ? "Ficha actualizada" : "Cliente agregado a cobranza");
  };
  const eliminarCliente = id => {
    removeCliente(id);
    toast("Cliente quitado de cobranza");
  };
  const agregarTodos = () => {
    setCobranza(prev => {
      const p = prev || {};
      const cd = { ...(p.clientesData || {}) };
      (dist || []).forEach(d => {
        const cid = String(d.id);
        if (!cid) return;
        if (!cd[cid]) { cd[cid] = { cartera: "dist", saldo: 0, pagoMensual: 0, historial: [] }; }
        else if (cd[cid]._oculto) { cd[cid] = { ...cd[cid], _oculto: false }; }
      });
      return { ...p, clientesData: cd };
    });
    toast("Clientes de Distribución agregados a cobranza");
  };

  // Importación de pagos automáticos: agrega el cliente a cobranza (si hace match) y crea/actualiza el auto
  const procesarAutos = items => {
    setCobranza(prev => {
      const p = prev || {};
      const cd = {
        ...(p.clientesData || {})
      };
      let recs = [...(p.recurrentes || [])];
      let nuevos = 0,
        actualizados = 0,
        agregados = 0;
      items.forEach(it => {
        const id = String(it.clienteId);
        if (!id) return;
        if (!cd[id]) {
          cd[id] = {
            cartera: "dist",
            saldo: 0,
            pagoMensual: +it.monto || 0,
            historial: []
          };
          agregados++;
        } else if ((!cd[id].pagoMensual || +cd[id].pagoMensual === 0) && it.monto) cd[id] = {
          ...cd[id],
          pagoMensual: +it.monto
        };
        const base = {
          clienteId: id,
          dia: +it.dia || 1,
          monto: +it.monto || 0,
          last4: it.last4,
          exp: it.exp,
          activo: true
        };
        const k = recs.findIndex(r => String(r.clienteId) === id && r.last4 === it.last4 && r.exp === it.exp);
        if (k >= 0) {
          recs[k] = {
            ...recs[k],
            ...base
          };
          actualizados++;
        } else {
          recs.push({
            ...base,
            id: Date.now() + Math.floor(Math.random() * 100000)
          });
          nuevos++;
        }
      });
      return {
        ...p,
        clientesData: cd,
        recurrentes: recs
      };
    });
  };
  const backupJSON = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify({
      clientesData,
      recurrentes,
      meses,
      cfg
    }, null, 2)], {
      type: "application/json"
    }));
    a.download = `cobranza-backup-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Respaldo descargado");
  };
  const restoreJSON = file => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        setCobranza(prev => ({
          ...(prev || {}),
          clientesData: d.clientesData || (prev || {}).clientesData || {},
          recurrentes: d.recurrentes || (prev || {}).recurrentes || [],
          meses: d.meses || (prev || {}).meses || {},
          cfg: d.cfg || (prev || {}).cfg || {}
        }));
        toast("Respaldo restaurado");
      } catch {
        toast("Archivo inválido", "err");
      }
    };
    r.readAsText(file);
  };
  const tabs = [{
    id: "dashboard",
    icon: LayoutDashboard,
    label: "Panel"
  }, {
    id: "clientes",
    icon: Users,
    label: "Clientes"
  }, {
    id: "cobranza",
    icon: Target,
    label: "Cobranza"
  }, {
    id: "recurrentes",
    icon: RefreshCw,
    label: "Auto"
  }, {
    id: "reportes",
    icon: FileText,
    label: "Reportes"
  }, {
    id: "config",
    icon: Settings,
    label: "Config"
  }];
  return <div style={{
    fontFamily: T.mono,
    color: T.text
  }}>
      <div style={{
      display: "flex",
      gap: 6,
      flexWrap: "wrap",
      marginBottom: 18,
      borderBottom: `1px solid ${T.border}`,
      paddingBottom: 12
    }}>
        {tabs.map(t => {
        const act = tab === t.id;
        const crit = t.id === "cobranza" ? resumen.cats.rojo.length : 0;
        return <button key={t.id} onClick={() => setTab(t.id)} style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "8px 14px",
          background: act ? T.blue : T.bluePale,
          border: `1px solid ${act ? T.blue : T.borderHi}`,
          borderRadius: 20,
          color: act ? "#fff" : T.blueMid,
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer"
        }}>
              <t.icon size={14} /> {t.label}
              {crit > 0 && <span style={{
            background: act ? "rgba(255,255,255,.25)" : T.red,
            color: "#fff",
            borderRadius: 10,
            fontSize: 9,
            fontWeight: 800,
            padding: "1px 6px"
          }}>{crit}</span>}
            </button>;
      })}
      </div>

      {tab === "dashboard" && <Dashboard resumen={resumen} prioritarios={prioritarios} isMobile={isMobile} irCobranza={() => setTab("cobranza")} mesKey={mesKey} mesCfg={mesCfg} setMeses={setMeses} cobradoCartera={cobradoCartera} clientes={enriquecidos} onPago={registrarPago} onPagoExterno={registrarPagosExternos} pagosExternos={pagosExternos} kpi={kpiHyCite} cfg={cfgSesion} onRomper={romperPromesa} puedeEditarMes={true} snapsMes={snapsMes} onReporteFin={guardarReporteFin} pagosDespues={pagosDesdeReporte} />}
      {tab === "clientes" && <Clientes data={enriquecidos} isMobile={isMobile} onGuardar={guardarCliente} onEliminar={eliminarCliente} onPago={registrarPago} onDeshacer={deshacerPago} cfg={cfgSesion} puedeBorrar={true} mesKey={mesKey} onPromesa={guardarPromesa} onRomper={romperPromesa} onAgregarTodos={agregarTodos} disponibles={disponibles} onImportarIA={importarClientesIA} onFusionarDuplicados={fusionarDuplicadosCobranza} onEliminarVarios={eliminarVariosClientes} />}
      {tab === "cobranza" && <Cobranza data={prioritarios} resumen={resumen} cfg={cfgSesion} onPago={registrarPago} isMobile={isMobile} th={th} kpi={kpiHyCite} mesKey={mesKey} onPromesa={guardarPromesa} />}
      {tab === "recurrentes" && <Recurrentes recurrentes={recurrentes} setRecurrentes={setRecurrentes} clientes={clientes} isMobile={isMobile} distribucion={dist} onImport={procesarAutos} />}
      {tab === "reportes" && <Reportes data={enriquecidos} recurrentes={recurrentes} clientes={clientes} resumen={resumen} />}
      {tab === "config" && <Config cfg={cfgSesion} setCfg={setCfg} onBackup={backupJSON} onRestore={restoreJSON} onReset={reiniciarCobranza} />}

      <ToastHost />
    </div>;
}
  return { CobranzaSection };
})();
const CobranzaSection = __CobranzaModule.CobranzaSection;


/* ══════════════════════════════════════════════════════════════════
   MÓDULO CATÁLOGO RP — Buscador de Códigos + Simulador de Compra
   Catálogo fusionado: Excel 2026 (485) + app web v8 (30 extra) = 515 productos.
   Datos 100% estáticos (no tocan Firebase). Sin precios (decisión de Tomas).
   ══════════════════════════════════════════════════════════════════ */
const __CatalogoModule = (function () {

const CATALOGO_RP = [
{"c":"CU0056","n":"RP BLOQUE PARA CUCHILLOS","f":"Bloque para cuchillos Royal Prestige","g":"Cuchilleria","k":"cuchillo, knife, cortar, cuchilleria, porta cuchillos, bloque"},
{"c":"CU0148","n":"CUCHILLO SANTOKU DAMASCUS DE 5\"","f":"Cuchillo Santoku de Damasco de 5 pulgadas","g":"Cuchilleria","k":"cuchillo, knife, cortar, cuchilleria"},
{"c":"CU0740","n":"JGO DE 4 CUCHILLOS PARA CHURRASCO","f":"Juego de 4 cuchillos para churrasco","g":"Cuchilleria","k":"cuchillo, knife, cortar, cuchilleria"},
{"c":"CU0800","n":"RP JUEGO DE CUCHILLOS 5PZS","f":"Juego de 5 piezas de cuchillos Royal Prestige","g":"Cuchilleria","k":"cuchillo, knife, cortar, cuchilleria"},
{"c":"CU0810","n":"RP CUCHILLO PARA PELAR 2.75\"","f":"Cuchillo Royal Prestige de 2.75 pulgadas para pelar","g":"Cuchilleria","k":"cuchillo, knife, cortar, cuchilleria"},
{"c":"CU0814","n":"RP CUCHILLO MULTIUSO 5\"","f":"Cuchillo Royal Prestige multiuso de 5 pulgadas","g":"Cuchilleria","k":"cuchillo, knife, cortar, cuchilleria"},
{"c":"CU0815","n":"RP JUEGO PARA REBANAR 4PZS","f":"Juego de 4 piezas Royal Prestige para rebanar","g":"Cuchilleria","k":"cuchillo, knife, cortar, cuchilleria"},
{"c":"CU0820","n":"RP JGO CUCHILLOS PARA CARNE 4PZS","f":"Juego de 4 piezas de cuchillos Royal Prestige para carne","g":"Cuchilleria","k":"cuchillo, knife, cortar, cuchilleria"},
{"c":"CU0825","n":"RP HACHA DE COCINA 7\"","f":"Hacha de cocina Royal Prestige de 7 pulgadas","g":"Cuchilleria","k":"cuchillo, knife, cortar, cuchilleria"},
{"c":"CU0932","n":"RP TODO EN 1 BLOQUE CUCHILLOS CHURRASCO","f":"Bloque Royal Prestige \"todo en uno\" con cuchillos para churrasco","g":"Cuchilleria","k":"cuchillo, knife, cortar, cuchilleria, porta cuchillos, bloque"},
{"c":"SP0296","n":"RP CUCHILLO SANTOKU 5\"","f":"Cuchillo Santoku Royal Prestige de 5 pulgadas","g":"Cuchilleria","k":"cuchillo, knife, cortar, cuchilleria"},
{"c":"SP0297","n":"RP CUCHILLO SANTOKU 3.5\"/8.89CM","f":"Cuchillo Santoku Royal Prestige de 3.5 pulgadas o 8.89 cm","g":"Cuchilleria","k":"cuchillo, knife, cortar, cuchilleria"},
{"c":"ES0014","n":"POWER BLENDER JARRA TRITAN COMPLETA","f":"","g":"Electrodomesticos","k":"licuadora, blender, efecto piedra, antiadherente"},
{"c":"ES0071","n":"RP PRECISION COOK 120-127V TIPO B","f":"Cocina de precisión Royal Prestige 120-127 voltios tipo B","g":"Electrodomesticos","k":"estufa, cocina, parrilla electrica, hornilla, induccion"},
{"c":"ES0082","n":"RP POWER BLENDER MAX 120-127V VPU","f":"Licuadora Power Blender Max Royal Prestige 120-127 voltios por unidad","g":"Electrodomesticos","k":"licuadora, blender, licuadora grande, efecto piedra, antiadherente"},
{"c":"ES4200","n":"RP PB GO PLUS TIPO A C/BATIDOR & CEPILLO","f":"Royal Prestige Power Blender Go Plus tipo A con batidor y cepillo","g":"Electrodomesticos","k":"batidor, licuadora portatil, mini licuadora, inmersion"},
{"c":"JU0038","n":"EXTRACTOR DE JUGOS RP CON RECETARIO","f":"Extractor de jugos Royal Prestige con recetario","g":"Electrodomesticos","k":"extractor, juguera, jugos, juicer, recetario, recetas"},
{"c":"PE0028","n":"CONJUNTO PICADORA Y TAZA - BLENDER GO","f":"Conjunto de picadora y taza para Blender Go","g":"Electrodomesticos","k":"batidor, licuadora portatil, mini licuadora, inmersion, tazas, termo, cafe, efecto piedra, antiadherente"},
{"c":"PE0029","n":"CONJUNTO BATIDOR & CEPILLO - BLENDER GO","f":"Conjunto de batidor y cepillo para Blender Go","g":"Electrodomesticos","k":"batidor, licuadora portatil, mini licuadora, inmersion, efecto piedra, antiadherente"},
{"c":"PE0040","n":"RP FRESH MAX / ADAPTADOR TIPO A","f":"Royal Prestige Fresh Max/Adaptador tipo A","g":"Electrodomesticos","k":"sellado al vacio, bomba de vacio, conservar alimentos"},
{"c":"PE0050","n":"JARRA TRITAN COMPLETA RP PB MAX","f":"Jarra completa Tritan Royal Prestige para Power Blender Max","g":"Electrodomesticos","k":"licuadora, blender, licuadora grande"},
{"c":"PE0051","n":"RP MAX CUP (2) C/ASPAS","f":"2 vasos Max Cup Royal Prestige con aspas","g":"Electrodomesticos","k":"vaso licuadora, licuadora personal, smoothie"},
{"c":"PE4000","n":"ROYAL PRESTIGE WARMER PRO","f":"Calentador profesional Royal Prestige - tortillera","g":"Electrodomesticos","k":"calentador de comida, plato caliente, food warmer"},
{"c":"SP3303","n":"PAQT 6 JARRA VORT-X 2.5.1 COMPLETA","f":"Paquete de 6 jarras Vort-X 2.5.1 completas","g":"Electrodomesticos","k":"jarra, vortex"},
{"c":"CO9144","n":"OLLA ROYAL PRESTIGE 60QT Y PARRILLA","f":"Olla Royal Prestige de 60 cuartos con parrilla","g":"Especial y Promociones","k":"tamalera, olla grande, vaporera, tamales, olla gigante, rejilla, base para tamales, olla, cocinar, pot"},
{"c":"CO9267","n":"OLLA 12QT CON PARRILLA INNOVE 316L","f":"Olla de 12 cuartos con parrilla Innové 316L","g":"Especial y Promociones","k":"tamalera, olla grande, vaporera, tamales, rejilla, base para tamales, olla, cocinar, pot, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9269","n":"OLLA 30QT/38CM Y PARRILLA INNOVE 316L","f":"Olla de 30 cuartos o 38 cm con parrilla Innové 316L","g":"Especial y Promociones","k":"tamalera, olla grande, vaporera, tamales, rejilla, base para tamales, olla, cocinar, pot, innove, linea innove, 316L, titanio quirurgico"},
{"c":"AP2704","n":"RP FILTRO AIRE PAQUETE REEMPLAZO","f":"Paquete de reemplazo de filtro de aire Royal Prestige","g":"Filtracion","k":"purificador de aire, aire"},
{"c":"AP2801","n":"RP FILTRO DE AIRE 120-127V TIPO A","f":"Filtro de aire Royal Prestige de 120-127 voltios tipo A","g":"Filtracion","k":"purificador de aire, aire"},
{"c":"PR0333","n":"ROYAL PRESTIGE FILTRO DE DUCHA","f":"Filtro de ducha Royal Prestige","g":"Filtracion","k":"filtro de ducha, regadera, shower"},
{"c":"PR2002","n":"2 UNIDADES DE PREFILTRO","f":"2 unidades de prefiltro","g":"Filtracion","k":"repuesto filtro, cartucho, filtro de agua"},
{"c":"PR2003","n":"1 UNIDAD FILTRO OSMOSIS INVERSA","f":"1 unidad de filtro de ósmosis inversa","g":"Filtracion","k":"osmosis inversa, filtro de agua"},
{"c":"PR2004","n":"1 UND MINERALIZADOR + 1 UND FILTRO CARBON","f":"1 unidad de mineralizador y 1 unidad de filtro de carburo","g":"Filtracion","k":"filtro de agua, minerales"},
{"c":"RP0140","n":"CARTUCHO DE SEDIMENTO DE 10\"","f":"Cartucho de sedimento de 10 pulgadas","g":"Filtracion","k":"repuesto filtro, cartucho, filtro de agua"},
{"c":"RP4621","n":"RP KIT REEMPLAZO CUBIERTA DE DUCHA","f":"Kit de reemplazo Royal Prestige para cubierta de ducha","g":"Filtracion","k":"filtro de ducha, regadera, shower"},
{"c":"RP6186","n":"VALVULA DESVIO - DOBLE MANGUERA METAL","f":"Válvula de desvío con doble manguera de metal","g":"Filtracion","k":"royal prestige"},
{"c":"RP6196","n":"VALVULA DE METAL - MANGUERA SIMPLE","f":"Válvula de metal con manguera simple","g":"Filtracion","k":"royal prestige"},
{"c":"RP9003","n":"RP FRESCAFLOW KIT DE MUDANZA","f":"Kit de mudanza Royal Prestige Frescaflow","g":"Filtracion","k":"filtro de agua, purificador, agua"},
{"c":"WF0060","n":"PRE-FILTRO DE 10\" CON 3 CARTUCHOS","f":"Prefiltro de 10 pulgadas con 3 cartuchos","g":"Filtracion","k":"filtro de agua, purificador, agua, repuesto filtro, cartucho"},
{"c":"WF0075","n":"DOS (2) CARTUCHOS FILTRO P/DUCHA","f":"2 cartuchos de filtro para ducha","g":"Filtracion","k":"filtro de agua, purificador, agua, filtro de ducha, regadera, shower, repuesto filtro, cartucho"},
{"c":"WF0080","n":"SEIS (6) CARTUCHOS FILTRO P/DUCHA","f":"6 cartuchos de filtro para ducha","g":"Filtracion","k":"filtro de agua, purificador, agua, filtro de ducha, regadera, shower, repuesto filtro, cartucho"},
{"c":"WF0382","n":"PREFILTRO P/SEDIMENTOS 5 MICRONES","f":"Prefiltro para sedimentos de 5 micrones","g":"Filtracion","k":"filtro de agua, purificador, agua, repuesto filtro, cartucho"},
{"c":"WF0419","n":"FILTRO DE AGUA FRESCAPURE 3500 CT","f":"Filtro de agua Frescasure 3500 CT","g":"Filtracion","k":"filtro de agua, purificador, agua"},
{"c":"WF0482","n":"FRESCAPURE 5500 SOBRE MOSTRADOR","f":"Frescasure 5500 para mostrador","g":"Filtracion","k":"filtro de agua, purificador, agua"},
{"c":"WF0485","n":"FRESCAPURE 5500 BAJO MOSTRADOR","f":"Frescasure 5500 para debajo del mostrador","g":"Filtracion","k":"filtro de agua, purificador, agua"},
{"c":"WF0490","n":"RP 4.5\" NSF CERT CARTUCHO DE REEMPLAZO","f":"","g":"Filtracion","k":"filtro de agua, purificador, agua, repuesto filtro, cartucho"},
{"c":"WF0491","n":"FP3K/PLUS/3500 REPLACEMENT CARTRIDGE","f":"","g":"Filtracion","k":"filtro de agua, purificador, agua, repuesto filtro, cartucho"},
{"c":"WF0530","n":"CARTUCHO 4.5 C/CAPSULA P/BTR FP BAJO MOSTRADOR","f":"Cartucho de 4.5 pulgadas con cápsula para batería, para Frescasure bajo mostrador","g":"Filtracion","k":"filtro de agua, purificador, agua, repuesto filtro, cartucho"},
{"c":"WF0653","n":"UNIDAD ULTRAVIOLETA - FP ULTRA","f":"Unidad ultravioleta para Frescasure Ultra","g":"Filtracion","k":"filtro de agua, purificador, agua, uv, esterilizador"},
{"c":"WF0654","n":"FP ULTRA - 3 FILTROS DE REEMPLAZO","f":"Frescasure Ultra - 3 filtros de reemplazo","g":"Filtracion","k":"filtro de agua, purificador, agua"},
{"c":"WF1200","n":"RP FRESCAFLOW 100-240V & MINERALIZADOR","f":"Royal Prestige Frescaflow de 100 a 240 voltios con mineralizador","g":"Filtracion","k":"filtro de agua, purificador, agua, minerales"},
{"c":"CO1678","n":"6 PC GOURMET (PANS W/COVERS) 5PLY","f":"6 piezas Gourmet (sartenes con cubiertas) de 5 capas","g":"Juegos de Ollas","k":"gourmet, 5 capas"},
{"c":"CO3000","n":"RP ELITE SET 5PZ C/3 PROTECTORES SARTENES","f":"Royal Prestige Elite de 5 piezas con cubiertas y protector de 3 piezas","g":"Juegos de Ollas","k":"sarten, freir, frying pan, elite, linea elite"},
{"c":"CO3011","n":"RP ELITE SARTEN 26CM/3.5QT C/TAPA","f":"Royal Prestige Elite sartén para saltear de 26 cm / 3.5 cuartos con cubierta","g":"Juegos de Ollas","k":"sarten, freir, frying pan, elite, linea elite"},
{"c":"CO3012","n":"RP ELITE OLLA 22CM/4QT C/TAPA","f":"Royal Prestige Elite horno holandés de 22 cm / 4 cuartos con cubierta","g":"Juegos de Ollas","k":"olla, cocinar, pot, elite, linea elite"},
{"c":"CO3013","n":"RP ELITE SARTEN 10\"","f":"Royal Prestige Elite sartén de 10 pulgadas","g":"Juegos de Ollas","k":"sarten, freir, frying pan, elite, linea elite"},
{"c":"CO3014","n":"RP ELITE SARTEN 8\"","f":"Royal Prestige Elite sartén de 8 pulgadas","g":"Juegos de Ollas","k":"sarten, freir, frying pan, elite, linea elite"},
{"c":"CO3015","n":"RP ELITE TAPA 26CM","f":"","g":"Juegos de Ollas","k":"elite, linea elite"},
{"c":"CO4911","n":"ROYAL PRESTIGE MULTIPAN","f":"Multiguisado Royal Prestige","g":"Juegos de Ollas","k":"olla multiusos, vaporera, silbato, multiuso"},
{"c":"CO7014","n":"SIST COCINA COMPLEMENTO 5CPS-5PZS C/CATALOGO","f":"Sistema de cocina complementario de 5 capas y 5 piezas con catálogo","g":"Juegos de Ollas","k":"5 capas, catalogo"},
{"c":"CO7024","n":"SIST COCINA CLASICO 5 CAPAS 7PZS C/CATALOGO","f":"Sistema de cocina Clásico de 5 capas y 7 piezas con catálogo","g":"Juegos de Ollas","k":"5 capas, catalogo"},
{"c":"CO7034","n":"SIST CLASICO 5CPS 8PZS C/CATALOGO","f":"Sistema Clásico de 5 capas y 8 piezas con catálogo","g":"Juegos de Ollas","k":"5 capas, catalogo"},
{"c":"CO7054","n":"SIST COCINA PROFESIONAL 5CPS 15PZS C/CATALOGO","f":"Sistema de cocina Profesional de 5 capas y 15 piezas con catálogo","g":"Juegos de Ollas","k":"5 capas, catalogo"},
{"c":"CO8020","n":"SIST COCINA CLASICO 5 CAPAS 7 PZAS","f":"Sistema de cocina Clásico de 5 capas y 7 piezas","g":"Juegos de Ollas","k":"5 capas"},
{"c":"CO8030","n":"SIST COCINA ESPECIAL 5 CAPAS 8 PZAS","f":"Sistema de cocina Especial de 5 capas y 8 piezas","g":"Juegos de Ollas","k":"5 capas"},
{"c":"CO8040","n":"SIST COCINA FAMILIAR DE 5CPS 10PZS","f":"","g":"Juegos de Ollas","k":"5 capas"},
{"c":"CO9251","n":"CLASICO 7PZS INNOVE 316L + MATERIAL APOYO","f":"Juego Clásico de 7 piezas Innové 316L con material de apoyo","g":"Juegos de Ollas","k":"innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9256","n":"ESPECIAL 8PZS INNOVE 316L + MATERIAL APOYO","f":"Juego Especial de 8 piezas Innové 316L con material de apoyo","g":"Juegos de Ollas","k":"innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9265","n":"JGO SARTENES GOURMET 6PZS INNOVE 316L","f":"Juego de sartenes Gourmet de 6 piezas Innové 316L","g":"Juegos de Ollas","k":"sarten, freir, frying pan, innove, linea innove, gourmet, 316L, titanio quirurgico"},
{"c":"CO9554","n":"SISTEMA DE 15 PZAS NOVEL SIN CATALOGO","f":"Sistema Novel de 15 piezas sin catálogo","g":"Juegos de Ollas","k":"novel, linea novel, catalogo"},
{"c":"CO9563","n":"SISTEMA NOVEL 7 PZS SIN CATALOGO","f":"Sistema Novel de 7 piezas sin catálogo","g":"Juegos de Ollas","k":"novel, linea novel, catalogo"},
{"c":"CO9573","n":"SISTEMA NOVEL 8 PZS SIN CATALOGO","f":"Sistema Novel de 8 piezas sin catálogo","g":"Juegos de Ollas","k":"novel, linea novel, catalogo"},
{"c":"CO9655","n":"JGO 6PZS GOURMET (SARTENES C/TAPA)","f":"Juego de 6 piezas Gourmet (sartenes con tapa)","g":"Juegos de Ollas","k":"sarten, freir, frying pan, gourmet"},
{"c":"CO9736","n":"8\" DER SARTEN EFECTO PIEDRA + 3PZ UTENSILIOS","f":"Sartén de 8 pulgadas de Easy Release con efecto de piedra y 3 piezas de utensilio","g":"Juegos de Ollas","k":"sarten, freir, frying pan, efecto piedra, antiadherente, utensilios, servir"},
{"c":"CO9738","n":"10\" DER SARTEN EFECTO PIEDRA + 3PZ UTENSILIOS","f":"Sartén de 10 pulgadas de Easy Release con efecto de piedra y 3 piezas de utensilio","g":"Juegos de Ollas","k":"sarten, freir, frying pan, efecto piedra, antiadherente, utensilios, servir"},
{"c":"CO9739","n":"12\" DER SARTEN EFECTO PIEDRA + 3PZ UTENSILIOS","f":"Sartén de 12 pulgadas de Easy Release con efecto de piedra y 3 piezas de utensilio","g":"Juegos de Ollas","k":"sarten, freir, frying pan, efecto piedra, antiadherente, utensilios, servir"},
{"c":"CO9740","n":"6PC SET DER EFECTO PIEDRA 3PZ UTENSILIOS","f":"Juego de 6 piezas de Easy Release con efecto de piedra y 3 piezas de utensilio","g":"Juegos de Ollas","k":"efecto piedra, antiadherente, utensilios, servir"},
{"c":"CO9777","n":"2QT/18CM ER OLLA C/TAPA VIDRIO/3PZ UTEN","f":"Olla de 2 cuartos o 18 cm de Easy Release con tapa de vidrio y 3 piezas de utensilio","g":"Juegos de Ollas","k":"olla, cocinar, pot, antiadherente, easy release"},
{"c":"CO9778","n":"3QT/20CM ER OLLA C/TAPA VIDRIO/3PZ UTEN","f":"Olla de 3 cuartos o 20 cm de Easy Release con tapa de vidrio y 3 piezas de utensilio","g":"Juegos de Ollas","k":"olla, cocinar, pot, antiadherente, easy release"},
{"c":"CO9779","n":"3.5QT/26CM ER SAUTE/TAPA VIDRIO/3PZ UTEN","f":"Sartén para saltear de 3.5 cuartos o 26 cm de Easy Release con tapa de vidrio y 3 piezas de utensilio","g":"Juegos de Ollas","k":"antiadherente, easy release"},
{"c":"CO9780","n":"RP EASY RELEASE OLLAS & SARTEN 6 PZS","f":"Juego de ollas y sartén Royal Prestige Easy Release de 6 piezas","g":"Juegos de Ollas","k":"sarten, freir, frying pan, antiadherente, easy release"},
{"c":"CO9840","n":"NOVEL 10PZ SC FAMILIAR (TAPA ALTA)","f":"","g":"Juegos de Ollas","k":"novel, linea novel"},
{"c":"CO9846","n":"INNOVE 5PZ + CATALOGO + PERFECT POP","f":"Juego Innové de 5 piezas con catálogo y Perfect Pop","g":"Juegos de Ollas","k":"palomitas, popcorn, crispetas, cotufas, innove, linea innove, catalogo"},
{"c":"CO9861","n":"INNOVE 10PZ + PERFECT POP","f":"Juego Innové de 10 piezas con Perfect Pop","g":"Juegos de Ollas","k":"palomitas, popcorn, crispetas, cotufas, innove, linea innove"},
{"c":"CO9883","n":"NOVEL 10PZ + CATALOGO + POP","f":"Juego Novel de 10 piezas con catálogo y Pop","g":"Juegos de Ollas","k":"novel, linea novel, catalogo"},
{"c":"CO9893","n":"NOVEL 5PZ + CATALOGO + POP","f":"Juego Novel de 5 piezas con catálogo y Pop","g":"Juegos de Ollas","k":"novel, linea novel, catalogo"},
{"c":"SP7008","n":"KIT DE 5 CAPAS PARA EL NOVATO","f":"Kit de 5 capas para el novato","g":"Kits Novato","k":"5 capas, kit inicial, demo, nuevo distribuidor, arranque"},
{"c":"SP9001","n":"KIT INNOVE PARA EL NOVATO","f":"Kit Innové para el novato","g":"Kits Novato","k":"innove, linea innove, kit inicial, demo, nuevo distribuidor, arranque"},
{"c":"SP9005","n":"KIT NOVEL PARA EL NOVATO","f":"Kit Novel para el novato","g":"Kits Novato","k":"kit inicial, demo, nuevo distribuidor, arranque"},
{"c":"LT0005","n":"CATALOGO DE PRODUCTOS 5 CAPAS ING/ESP","f":"Catálogo de productos de 5 capas en inglés y español","g":"Literatura de Venta","k":"5 capas, folleto, material de venta, papeleria, catalogo"},
{"c":"LT0043","n":"MEGA BROCHURE ELITE COOKING SYSTEM","f":"","g":"Literatura de Venta","k":"elite, linea elite, folleto, material de venta, papeleria"},
{"c":"LT0102","n":"FOLLETO CHOCOLATERA","f":"Folleto Chocolatera","g":"Literatura de Venta","k":"chocolate caliente, champurrado, olla chocolate, folleto, material de venta, papeleria"},
{"c":"LT0105","n":"FOLLETO EXPERTEA ESPAÑOL-INGLES","f":"Folleto Expertea en inglés y español","g":"Literatura de Venta","k":"tetera, te, infusor, tea, folleto, material de venta, papeleria"},
{"c":"LT0131","n":"FOLLETO PRECISION COOK","f":"Folleto Precision Cook","g":"Literatura de Venta","k":"estufa, cocina, parrilla electrica, hornilla, induccion, folleto, material de venta, papeleria"},
{"c":"LT0601","n":"FOLLETO FRESCAPURE 5500 ESPAÑOL","f":"Folleto Frescasure 5500 en español","g":"Literatura de Venta","k":"filtro de agua, purificador, agua, folleto, material de venta, papeleria"},
{"c":"LT1199","n":"RECETARIO INNOVE Y NOVEL ING/ESP","f":"Recetario Innové y Novel en inglés y español","g":"Literatura de Venta","k":"innove, linea innove, novel, linea novel, folleto, material de venta, papeleria, recetario, recetas"},
{"c":"LT2189","n":"RECETARIO OLLA DE PRESION","f":"","g":"Literatura de Venta","k":"olla express, pressure cooker, olla pitadora, presion, olla, cocinar, pot, folleto, material de venta, papeleria, recetario, recetas"},
{"c":"LT2268","n":"FOLLETO DE EXTRACTOR DE JUGOS RP","f":"Folleto de extractor de jugos Royal Prestige","g":"Literatura de Venta","k":"extractor, juguera, jugos, juicer, folleto, material de venta, papeleria"},
{"c":"LT2377","n":"FOLLETO OLLAS DE PRESION","f":"","g":"Literatura de Venta","k":"olla express, pressure cooker, olla pitadora, presion, folleto, material de venta, papeleria"},
{"c":"LT2597","n":"FOLLETO DEL FRESCAPURE 3500 ESP","f":"Folleto del Frescasure 3500 en español","g":"Literatura de Venta","k":"filtro de agua, purificador, agua, folleto, material de venta, papeleria"},
{"c":"LT2661","n":"SUPER FOLLETO MAQUINA P/ENSALADA","f":"Súper folleto de máquina para ensalada","g":"Literatura de Venta","k":"cortador de verduras, rallador, ensaladas, procesador, folleto, material de venta, papeleria"},
{"c":"LT2900","n":"CATALOGO RP NOVEL ESP/ING","f":"Catálogo Royal Prestige Novel en español e inglés","g":"Literatura de Venta","k":"novel, linea novel, folleto, material de venta, papeleria, catalogo"},
{"c":"LT2917","n":"CATALOGO EASY RELEASE TAPA VIDRIO","f":"Catálogo Easy Release de tapa de vidrio","g":"Literatura de Venta","k":"antiadherente, easy release, folleto, material de venta, papeleria, catalogo"},
{"c":"LT3206","n":"FOLLETO POWER BLENDER GO","f":"Folleto Power Blender Go","g":"Literatura de Venta","k":"batidor, licuadora portatil, mini licuadora, inmersion, efecto piedra, antiadherente, folleto, material de venta, papeleria"},
{"c":"LT3211","n":"FOLLETO POWER BLENDER MAX","f":"Folleto Power Blender Max","g":"Literatura de Venta","k":"licuadora, blender, licuadora grande, efecto piedra, antiadherente, folleto, material de venta, papeleria"},
{"c":"LT4033","n":"CALENDARIO DE LA SUERTE RAFFLE 100PK","f":"Calendario del sorteo de la suerte, paquete de 100","g":"Literatura de Venta","k":"folleto, material de venta, papeleria"},
{"c":"LT4900","n":"FOLLETO ROYAL PRESTIGE MIXING BOWL","f":"Folleto Royal Prestige Mixing Bowl","g":"Literatura de Venta","k":"bowl, tazon, mezclar, batir, folleto, material de venta, papeleria"},
{"c":"LT4910","n":"FOLLETO ROYAL PRESTIGE MULTIPAN","f":"Folleto Royal Prestige Multiguisado","g":"Literatura de Venta","k":"olla multiusos, vaporera, silbato, multiuso, folleto, material de venta, papeleria"},
{"c":"LT4911","n":"MEGA BROCHURE MULTIPAN","f":"","g":"Literatura de Venta","k":"olla multiusos, vaporera, silbato, multiuso, folleto, material de venta, papeleria"},
{"c":"LT5260","n":"LIBRO DE RECETAS EXPERTEA","f":"Libro de recetas Expertea","g":"Literatura de Venta","k":"tetera, te, infusor, tea, folleto, material de venta, papeleria, recetario, recetas"},
{"c":"LT6310","n":"TRIPTICO OPORTUNIDAD INGLES PAQ 25","f":"Tríptico de oportunidad en inglés, paquete de 25","g":"Literatura de Venta","k":"folleto, material de venta, papeleria"},
{"c":"LT9002","n":"LAMINAS DE VENTAS INNOVE","f":"Láminas de ventas Innové","g":"Literatura de Venta","k":"innove, linea innove, folleto, material de venta, papeleria"},
{"c":"SP0001","n":"RP LUNCH BAG","f":"Bolsa de almuerzo Royal Prestige","g":"Materiales Clientes","k":"lonchera, bolsa de almuerzo"},
{"c":"SP0002","n":"RP ELITE BASE MAGNETICA","f":"","g":"Materiales Clientes","k":"elite, linea elite"},
{"c":"SP0066","n":"TAZON MEZCLAR 10QT C/BASE SILICONA","f":"Tazón para mezclar de 100T con base de silicona","g":"Materiales Clientes","k":"bowl, tazon, mezclar, batir"},
{"c":"SP0068","n":"TAZON 5 CUARTOS PARED DOBLE + TAPA","f":"Tazón de 5 cuartos con pared doble y tapa","g":"Materiales Clientes","k":"bowl, tazon, mezclar, batir"},
{"c":"SP0077","n":"DELUXE SERVING - CUCHARA","f":"","g":"Materiales Clientes","k":"utensilios, servir"},
{"c":"SP0078","n":"DELUXE SERVING - CUCHARA C/RANURAS","f":"","g":"Materiales Clientes","k":"utensilios, servir"},
{"c":"SP0079","n":"DELUXE SERVING - CUCHARA CUADRADA","f":"","g":"Materiales Clientes","k":"utensilios, servir"},
{"c":"SP0081","n":"NVO JGO P/SERVIR DELUXE 3PZS 430SS","f":"Nuevo juego Deluxe de 3 piezas de acero inoxidable 430 para servir","g":"Materiales Clientes","k":"utensilios, servir"},
{"c":"SP0088","n":"3PC NEW DELUXE SERVING SET 430SS 36PK","f":"Nuevo juego de 3 piezas de acero inoxidable 430 para servir, paquete de 36","g":"Materiales Clientes","k":"royal prestige"},
{"c":"SP0098","n":"JUEGO UTENSILIOS 3PZ EASY RELEASE","f":"Juego de 3 piezas de utensilios Easy Release","g":"Materiales Clientes","k":"antiadherente, easy release, utensilios, servir"},
{"c":"SP0111","n":"6 RECIPIENTES RP C/CAPACIDAD DE 2TZS","f":"6 recipientes Royal Prestige con capacidad de 2 tazas","g":"Materiales Clientes","k":"tuppers, contenedores, guardar comida"},
{"c":"SP0113","n":"RECIPIENTES DE COMIDA RP - 8 PIEZAS","f":"8 recipientes de comida Royal Prestige","g":"Materiales Clientes","k":"tuppers, contenedores, guardar comida"},
{"c":"SP0135","n":"JGO DE 4 TAZAS CON PARED DOBLE","f":"Juego de 4 tazas con pared doble","g":"Materiales Clientes","k":"tazas, termo, cafe"},
{"c":"SP0136","n":"JUEGO 2 TAZAS 16OZ CON PARED DOBLE","f":"Juego de 2 tazas de 16 onzas con pared doble","g":"Materiales Clientes","k":"tazas, termo, cafe"},
{"c":"SP0137","n":"TEQUILAS GLASS RP LOGO 4-PACK","f":"Vasos de tequila con logo de Royal Prestige, paquete de 4","g":"Materiales Clientes","k":"vasos, cristaleria, termo"},
{"c":"SP0145","n":"RECIPIENTE PARA UTENSILIOS","f":"Recipiente para utensilios","g":"Materiales Clientes","k":"tuppers, contenedores, guardar comida, utensilios, servir"},
{"c":"SP0152","n":"JUEGOS COMPLEMENTO 430SS + DLX + RECIPIENTE","f":"Juegos complementarios de acero inoxidable 430 más Deluxe y recipiente","g":"Materiales Clientes","k":"tuppers, contenedores, guardar comida"},
{"c":"SP0252","n":"JGO DE 2 COPAS P/HELADO C/PARED DOBLE","f":"Juego de 2 copas para helado con pared doble","g":"Materiales Clientes","k":"copas, vino, cristaleria"},
{"c":"SP0254","n":"JGO DE RECIPIENTES P/HELADO 4 PIEZAS","f":"Juego de 4 recipientes para helado","g":"Materiales Clientes","k":"tuppers, contenedores, guardar comida"},
{"c":"SP0261","n":"JGO AZUCAR/JARRO P/LECHE ACERO 2PZ","f":"Juego de azúcar y jarra de acero de 2 piezas para leche","g":"Materiales Clientes","k":"royal prestige"},
{"c":"SP0305","n":"BASE MAGNETICA PARA OLLAS","f":"Base magnética para ollas","g":"Materiales Clientes","k":"royal prestige"},
{"c":"SP1850","n":"DESTAPADOR PRECISION SERIES","f":"Destapador Precision Series","g":"Materiales Clientes","k":"utensilio, precision, abrelatas, abridor"},
{"c":"SP1851","n":"RALLADOR PRECISION SERIES","f":"Rallador Precision Series","g":"Materiales Clientes","k":"utensilio, precision, rallar, queso"},
{"c":"SP1852","n":"ESPATULA PRECISION SERIES","f":"Espátula Precision Series","g":"Materiales Clientes","k":"utensilio, precision, utensilios, servir"},
{"c":"SP1853","n":"BATIDOR DE GLOBO PRECISION SERIES","f":"Batidor de globo Precision Series","g":"Materiales Clientes","k":"utensilio, precision, batir, huevos, globo"},
{"c":"SP1854","n":"PELADOR PRECISION SERIES","f":"Pelador Precision Series","g":"Materiales Clientes","k":"utensilio, precision, pelar, verduras"},
{"c":"SP1856","n":"CORTAPIZZA PRECISION SERIES","f":"Corta pizza Precision Series","g":"Materiales Clientes","k":"utensilio, precision, pizza, cortador"},
{"c":"SP1857","n":"MACHACADOR PRECISION SERIES","f":"Machacador Precision Series","g":"Materiales Clientes","k":"utensilio, precision, pure, papas, aplastador"},
{"c":"SP1859","n":"ESPATULA P/HELADOS PRECISION SERIES","f":"Espátula para helados Precision Series","g":"Materiales Clientes","k":"utensilio, precision, utensilios, servir"},
{"c":"SP1860","n":"PELADOR VERTICAL PRECISION SERIES","f":"Pelador vertical Precision Series","g":"Materiales Clientes","k":"utensilio, precision, pelar, verduras"},
{"c":"SP1861","n":"JGO DE 2 ESPATULAS DE SILICONA PS","f":"Juego de 2 espátulas de silicona Precision Series","g":"Materiales Clientes","k":"utensilio, precision, utensilios, servir"},
{"c":"SP2551","n":"ROYAL PRESTIGE SMART TEMP","f":"Royal Prestige Smart Temp","g":"Materiales Clientes","k":"indicador de temperatura, termometro, sensor"},
{"c":"SP2881","n":"RP PAQUETE DE 10 UND SMART TEMP","f":"Paquete Royal Prestige de 10 unidades de Smart Temp","g":"Materiales Clientes","k":"indicador de temperatura, termometro, sensor"},
{"c":"CO8820","n":"COLADOR PEQUEÑO (20CM) 5Y9 CAPAS","f":"Colador pequeño de 20 cm de 5 y 9 capas","g":"Miscelaneos","k":"colador, escurridor, strainer, 9 capas"},
{"c":"CO9076","n":"COLADOR PEQUEÑO (20CM) INNOVE","f":"Colador pequeño de 20 cm Innové","g":"Miscelaneos","k":"colador, escurridor, strainer, innove, linea innove"},
{"c":"CO9080","n":"COLADOR GRANDE (26CM) INNOVE","f":"Colador grande de 26 cm Innové","g":"Miscelaneos","k":"colador, escurridor, strainer, innove, linea innove"},
{"c":"CO9096","n":"PARRILLA PARA OLLA DE 12QT INNOVE","f":"Parrilla para olla Innové de 12 cuartos","g":"Miscelaneos","k":"tamalera, olla grande, vaporera, tamales, rejilla, base para tamales, olla, cocinar, pot, innove, linea innove"},
{"c":"CO9097","n":"PARRILLA PARA OLLA DE 20QT INNOVE","f":"Parrilla para olla Innové de 20 cuartos","g":"Miscelaneos","k":"tamalera, olla grande, vaporera, tamales, rejilla, base para tamales, olla, cocinar, pot, innove, linea innove"},
{"c":"CO9098","n":"PARRILLA PARA OLLA DE 30QT INNOVE","f":"Parrilla para olla Innové de 30 cuartos","g":"Miscelaneos","k":"tamalera, olla grande, vaporera, tamales, rejilla, base para tamales, olla, cocinar, pot, innove, linea innove"},
{"c":"CO9099","n":"PARRILLA P/OLLA DE 60 CUARTOS RP","f":"Parrilla para olla Royal Prestige de 60 cuartos","g":"Miscelaneos","k":"tamalera, olla grande, vaporera, tamales, olla gigante, rejilla, base para tamales"},
{"c":"CO9615","n":"COLADOR PEQUEÑO (20CM) RP","f":"Colador pequeño de 20 cm Royal Prestige","g":"Miscelaneos","k":"colador, escurridor, strainer"},
{"c":"CO9690","n":"PARRILLA ACERO INOX 31CM OLLAS 20/30 RP","f":"Parrilla de acero inoxidable de 31 cm para ollas de 20/30 Royal Prestige","g":"Miscelaneos","k":"rejilla, base para tamales, vaporera, tamalera"},
{"c":"SP5050","n":"ROYALSHINE","f":"Royal Shine","g":"Miscelaneos","k":"limpiador, pulidor, acero inoxidable"},
{"c":"SP5054","n":"ROYAL SHINE - PAQUETE DE 12 UNIDADES","f":"Paquete de 12 unidades de Royal Shine","g":"Miscelaneos","k":"limpiador, pulidor, acero inoxidable"},
{"c":"LT2325","n":"NOTIFICACION CLIENTES ILLINOIS PQT 25","f":"Notificación a clientes de Illinois, paquete de 25","g":"Ordenes de Compra","k":"ordenes, contratos, papeleria, credito"},
{"c":"LT2700","n":"25 ORDENES VENTA RP MULTI ESTADO ING","f":"25 órdenes de venta Royal Prestige multi estado en inglés","g":"Ordenes de Compra","k":"ordenes, contratos, papeleria, credito"},
{"c":"LT2705","n":"25 ORDENES VENTA RP MULTI ESTADO ESP","f":"25 órdenes de venta Royal Prestige multi estado en español","g":"Ordenes de Compra","k":"ordenes, contratos, papeleria, credito"},
{"c":"LT2740","n":"25 SOLICITUDES CREDITO RP MULTI EDO RTVO ING","f":"25 solicitudes de crédito Royal Prestige multi estado rotativo en inglés","g":"Ordenes de Compra","k":"ordenes, contratos, papeleria, credito"},
{"c":"LT2745","n":"25 SOLICITUDES CREDITO RP MULTI EDO RTVO ESP","f":"25 solicitudes de crédito Royal Prestige multi estado rotativo en español","g":"Ordenes de Compra","k":"ordenes, contratos, papeleria, credito"},
{"c":"LT2750","n":"SOLICITUD GENERICA CREDITO ROTATIVO ING 25","f":"Solicitud genérica de crédito rotativo en inglés, paquete de 25","g":"Ordenes de Compra","k":"ordenes, contratos, papeleria, credito"},
{"c":"LT2795","n":"HOJA DE RESUMEN ESP PQT 25","f":"Hoja de resumen en español, paquete de 25","g":"Ordenes de Compra","k":"ordenes, contratos, papeleria, credito"},
{"c":"LT2797","n":"HOJA DE RESUMEN ING PQT 25","f":"Hoja de resumen en inglés, paquete de 25","g":"Ordenes de Compra","k":"ordenes, contratos, papeleria, credito"},
{"c":"RP0001","n":"ANILLO TUERCA BLANCO P/GRIFO FP5K/6K","f":"Anillo de tuerca blanco para grifo de Frescasure 5000/6000","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP0003","n":"PERILLA TAPA VIDRIO EASY RELEASE","f":"Perilla de tapa de vidrio de Easy Release","g":"Partes de Reemplazo","k":"antiadherente, easy release, repuesto, refaccion, parte, mango, agarradera, handle, tapa, tapadera"},
{"c":"RP0004","n":"DER ARO PARA TAPA DE VIDRIO 20CM","f":"Aro para tapa de vidrio de 20 cm","g":"Partes de Reemplazo","k":"efecto piedra, antiadherente, repuesto, refaccion, parte, empaque, sello, silicon, tapa, tapadera"},
{"c":"RP0006","n":"DER ARO PARA TAPA DE VIDRIO 30CM","f":"Aro de Easy Release para tapa de vidrio de 30 cm","g":"Partes de Reemplazo","k":"efecto piedra, antiadherente, repuesto, refaccion, parte, empaque, sello, silicon, tapa, tapadera"},
{"c":"RP0007","n":"SPACER 7/8\" FAUCET","f":"Espaciador para grifo de 7/8 pulgadas","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte"},
{"c":"RP0012","n":"ESPUMADOR DE LECHE BARISTART KIT","f":"Espumador de leche del kit Baristart","g":"Partes de Reemplazo","k":"cafetera, cafe, capuchino, espumador, leche espumada, barista, repuesto, refaccion, parte"},
{"c":"RP0023","n":"RP ELITE EMPAQUE SILICONA 22CM","f":"","g":"Partes de Reemplazo","k":"elite, linea elite, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP0024","n":"RP ELITE EMPAQUE SILICONA 26CM","f":"","g":"Partes de Reemplazo","k":"elite, linea elite, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP0026","n":"RP ELITE VALVULA REDI-TEMP","f":"","g":"Partes de Reemplazo","k":"elite, linea elite, repuesto, refaccion, parte, valvula, silbato"},
{"c":"RP0042","n":"RP BASE DE MOTOR POWER BLENDER MAX","f":"Base de motor Power Blender Max Royal Prestige","g":"Partes de Reemplazo","k":"licuadora, blender, licuadora grande, efecto piedra, antiadherente, repuesto, refaccion, parte"},
{"c":"RP0160","n":"3 ADAPTADORES PARA FILTRO DE AGUA","f":"3 adaptadores para filtro de agua","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte"},
{"c":"RP1257","n":"RP VALVULA PARA EXPERTEA","f":"Válvula Royal Prestige para Expertea","g":"Partes de Reemplazo","k":"tetera, te, infusor, tea, repuesto, refaccion, parte, valvula, silbato"},
{"c":"RP1258","n":"RP TAPA EXPERTEA","f":"Tapa Expertea Royal Prestige","g":"Partes de Reemplazo","k":"tetera, te, infusor, tea, repuesto, refaccion, parte, tapa, tapadera"},
{"c":"RP1259","n":"RP EXPERTEA MANIJA Y BASE","f":"Manija y base Royal Prestige Expertea","g":"Partes de Reemplazo","k":"tetera, te, infusor, tea, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP1263","n":"RP TAZA INFUSORA EXPERTEA","f":"Taza infusora Royal Prestige Expertea","g":"Partes de Reemplazo","k":"tetera, te, infusor, tea, tazas, termo, cafe, repuesto, refaccion, parte"},
{"c":"RP1350","n":"MANGUERA DE SALIDA P/PREFILTRO 10\"","f":"Manguera de salida para prefiltro de 10 pulgadas","g":"Partes de Reemplazo","k":"repuesto filtro, cartucho, filtro de agua, repuesto, refaccion, parte, manguera"},
{"c":"RP1670","n":"ANILLO O GRANDE P/FILTRO DE DUCHA","f":"Anillo \"O\" grande para filtro de ducha","g":"Partes de Reemplazo","k":"filtro de ducha, regadera, shower, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP1902","n":"AGARRADERA LARGA COMPLETA 7CPS","f":"Agarradera larga completa de 7 capas","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP1903","n":"NUEVA AGARRADERA COMPLETA 7 CAPAS","f":"Nueva agarradera completa de 7 capas","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP2224","n":"PB GO CHOPPER ATTACHMENT (PICADORA)","f":"","g":"Partes de Reemplazo","k":"batidor, licuadora portatil, mini licuadora, inmersion, repuesto, refaccion, parte"},
{"c":"RP2225","n":"PB GO BLENDING CUP (VASO)","f":"","g":"Partes de Reemplazo","k":"batidor, licuadora portatil, mini licuadora, inmersion, repuesto, refaccion, parte"},
{"c":"RP2229","n":"PB GO CHOPPER LID (TAPA PICADORA)","f":"","g":"Partes de Reemplazo","k":"batidor, licuadora portatil, mini licuadora, inmersion, repuesto, refaccion, parte, tapa, tapadera"},
{"c":"RP2230","n":"PB GO CHOPPER CONTAINER (RECIPIENTE)","f":"","g":"Partes de Reemplazo","k":"batidor, licuadora portatil, mini licuadora, inmersion, tuppers, contenedores, guardar comida, repuesto, refaccion, parte"},
{"c":"RP2231","n":"PB GO CHOPPER BLADE (CUCHILLA)","f":"","g":"Partes de Reemplazo","k":"batidor, licuadora portatil, mini licuadora, inmersion, repuesto, refaccion, parte"},
{"c":"RP2285","n":"VALVULA NUEVA RP OLLA DE PRESION","f":"Válvula de nueva olla de presión Royal Prestige","g":"Partes de Reemplazo","k":"olla express, pressure cooker, olla pitadora, presion, olla, cocinar, pot, repuesto, refaccion, parte, valvula, silbato"},
{"c":"RP2286","n":"RP MANGO NUEVA RP OLLA DE PRESION","f":"Mango Royal Prestige de nueva olla de presión","g":"Partes de Reemplazo","k":"olla express, pressure cooker, olla pitadora, presion, olla, cocinar, pot, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP2287","n":"ARO DE SILICONA NUEVA RP OLLA PRESION","f":"Aro de silicona de nueva olla de presión Royal Prestige","g":"Partes de Reemplazo","k":"olla express, pressure cooker, olla pitadora, presion, olla, cocinar, pot, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP2288","n":"RP CUBIERTA INDICADOR OLLA PRESION","f":"Cubierta de indicador Royal Prestige para olla de presión","g":"Partes de Reemplazo","k":"olla express, pressure cooker, olla pitadora, presion, olla, cocinar, pot, repuesto, refaccion, parte"},
{"c":"RP2289","n":"FILTRO VAPOR/TAPA OLLA PRESION","f":"Filtro de vapor para tapa de olla de presión","g":"Partes de Reemplazo","k":"olla express, pressure cooker, olla pitadora, presion, olla, cocinar, pot, repuesto, refaccion, parte, tapa, tapadera"},
{"c":"RP2290","n":"TUERCA APRIETE CUBIERTA DE CIERRE","f":"Tuerca de apriete para cubierta de cierre","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte"},
{"c":"RP2551","n":"RP SMART TEMP SILICONE HANDLE","f":"","g":"Partes de Reemplazo","k":"indicador de temperatura, termometro, sensor, repuesto, refaccion, parte"},
{"c":"RP3265","n":"ARO DE 38CM INNOVE ROJO","f":"Aro de 38 cm Innové, color rojo","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP3271","n":"AGARRADERA SUPERIOR INNOVE P/ARO MEDIANO","f":"Agarradera superior Innové para aro mediano","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, mango, agarradera, handle, empaque, sello, silicon"},
{"c":"RP3272","n":"AGARRADERA SUPERIOR INNOVE P/ARO GRANDE","f":"Agarradera superior Innové para aro grande","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, mango, agarradera, handle, empaque, sello, silicon"},
{"c":"RP3320","n":"PUREAMBIENCE II - CONTROL REMOTO","f":"Control remoto Pure Ambience II","g":"Partes de Reemplazo","k":"purificador de aire, aire, repuesto, refaccion, parte"},
{"c":"RP3337","n":"PRESIONADOR POWER BLENDER RP","f":"","g":"Partes de Reemplazo","k":"licuadora, blender, efecto piedra, antiadherente, repuesto, refaccion, parte"},
{"c":"RP3338","n":"RP POWER BLENDER BASE PAD SILICONA","f":"","g":"Partes de Reemplazo","k":"licuadora, blender, efecto piedra, antiadherente, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP3406","n":"JARRA DE VIDRIO P/LICUADORA PB MAX","f":"Jarra de vidrio para licuadora Power Blender Max","g":"Partes de Reemplazo","k":"licuadora, blender, licuadora grande, repuesto, refaccion, parte"},
{"c":"RP3410","n":"TAPON PLASTICO P/TAPA PB MAX","f":"Tapón de plástico para tapa de Power Blender Max","g":"Partes de Reemplazo","k":"licuadora, blender, licuadora grande, repuesto, refaccion, parte, tapa, tapadera"},
{"c":"RP3411","n":"TAPA DE LA JARRA POWER BLENDER MAX","f":"Tapa de jarra para Power Blender Max","g":"Partes de Reemplazo","k":"licuadora, blender, licuadora grande, efecto piedra, antiadherente, repuesto, refaccion, parte, tapa, tapadera"},
{"c":"RP3412","n":"ARO DE SILICONA P/TAPA PB MAX","f":"Aro de silicona para tapa de Power Blender Max","g":"Partes de Reemplazo","k":"licuadora, blender, licuadora grande, repuesto, refaccion, parte, empaque, sello, silicon, tapa, tapadera"},
{"c":"RP3413","n":"PRESIONADOR JARRA DE VIDRIO PB MAX","f":"Presionador de jarra de vidrio Power Blender Max","g":"Partes de Reemplazo","k":"licuadora, blender, licuadora grande, repuesto, refaccion, parte"},
{"c":"RP3414","n":"PRESIONADOR JARRA DE TRITAN PB MAX","f":"Presionador de jarra de Tritan Power Blender Max","g":"Partes de Reemplazo","k":"licuadora, blender, licuadora grande, repuesto, refaccion, parte"},
{"c":"RP3415","n":"BASE SILICONA LICUADORA PB MAX","f":"Base de silicona para licuadora Power Blender Max","g":"Partes de Reemplazo","k":"licuadora, blender, licuadora grande, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP3417","n":"ARO DE SILICONA/ASPAS/VIDRIO PB MAX","f":"Aro de silicona para aspas de vidrio de Power Blender Max","g":"Partes de Reemplazo","k":"licuadora, blender, licuadora grande, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP3419","n":"MECANISMO DE ASPAS Y TAPA P/RP MAX","f":"Mecanismo de aspas y tapa para Royal Prestige Max","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, tapa, tapadera"},
{"c":"RP3420","n":"TAPA PARA MAX CUP","f":"Tapa para Max Cup","g":"Partes de Reemplazo","k":"vaso licuadora, licuadora personal, smoothie, repuesto, refaccion, parte, tapa, tapadera"},
{"c":"RP3421","n":"ROYAL PRESTIGE MAX CUP JARRA SOLA","f":"Jarra Max Cup Royal Prestige sola","g":"Partes de Reemplazo","k":"vaso licuadora, licuadora personal, smoothie, repuesto, refaccion, parte"},
{"c":"RP3422","n":"ADAPTADOR COMPLETO FRESH MAX","f":"Adaptador completo Fresh Max","g":"Partes de Reemplazo","k":"sellado al vacio, bomba de vacio, conservar alimentos, repuesto, refaccion, parte"},
{"c":"RP3426","n":"PB MAX MECANISMO CUCHILLA JARRA VIDRIO","f":"Mecanismo de cuchilla para jarra de vidrio de Power Blender Max","g":"Partes de Reemplazo","k":"licuadora, blender, licuadora grande, repuesto, refaccion, parte"},
{"c":"RP3428","n":"RP MECANISMO COMPLETO CUCHILLA MAX CUP","f":"Mecanismo completo de cuchilla para Max Cup Royal Prestige","g":"Partes de Reemplazo","k":"vaso licuadora, licuadora personal, smoothie, repuesto, refaccion, parte"},
{"c":"RP3459","n":"GASKET PARA CUCHILLA MAX CUP","f":"Junta para cuchilla de Max Cup","g":"Partes de Reemplazo","k":"vaso licuadora, licuadora personal, smoothie, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP3600","n":"TOLVA DEL MAXTRACTOR","f":"Tolva del Maxtractor","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte"},
{"c":"RP3601","n":"ULTRA SQUEEZER DEL MAXTRACTOR","f":"Ultra Squeezer del Maxtractor","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte"},
{"c":"RP3602","n":"COLADOR DEL MAXTRACTOR","f":"Colador del Maxtractor","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, colador, escurridor, strainer, repuesto, refaccion, parte"},
{"c":"RP3603","n":"UNIDAD GIRATORIA DEL MAXTRACTOR","f":"Unidad giratoria del Maxtractor","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte"},
{"c":"RP3604","n":"TAZON DEL MAXTRACTOR","f":"Tazón del Maxtractor","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, bowl, tazon, mezclar, batir, repuesto, refaccion, parte"},
{"c":"RP3605","n":"PRESIONADOR DEL MAXTRACTOR","f":"Presionador del Maxtractor","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte"},
{"c":"RP3606","n":"RECIPIENTE JUGO C/MANIJA MAXTRACTOR/RP JUICER","f":"Recipiente para jugo con manija del Maxtractor/extractor de jugos Royal Prestige","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, tuppers, contenedores, guardar comida, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP3607","n":"RECIPIENTE PULPA S/MANIJA MAX/RP JUICER","f":"Recipiente para pulpa sin manija del Maxtractor/extractor de jugos Royal Prestige","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, tuppers, contenedores, guardar comida, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP3608","n":"CEPILLO PARA LIMPIAR MAXTRACTOR/RP JUICER","f":"Cepillo para limpiar material del extractor de jugos Royal Prestige","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte"},
{"c":"RP3609","n":"MAXTRACTOR TAPON DE SILICONA","f":"Tapón de silicona del Maxtractor","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP3610","n":"MOTOR (BASE) MAXTRACTOR/RP JUICER","f":"Motor (base) del Maxtractor/extractor de jugos Royal Prestige","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte"},
{"c":"RP3611","n":"TAPA INTELIGENTE DEL MAXTRACTOR","f":"Tapa inteligente del Maxtractor","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte, tapa, tapadera"},
{"c":"RP3617","n":"PIEZA PARA LIMPIAR MAXTRACTOR/RP JUICER","f":"Pieza para limpiar Maxtractor/extractor de jugos Royal Prestige","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte"},
{"c":"RP3628","n":"TOLVA ENSAMBLE P/EXTRACTOR DE JUGOS RP","f":"Tolva ensamblada para extractor de jugos Royal Prestige","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte"},
{"c":"RP3629","n":"RP EXTRACTOR JUGOS ULTRASQUEEZER","f":"Extractor de jugos Royal Prestige Ultra Squeezer","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte"},
{"c":"RP3630","n":"COLADOR PARA EXTRACTOR DE JUGOS RP","f":"Colador para extractor de jugos Royal Prestige","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, colador, escurridor, strainer, repuesto, refaccion, parte"},
{"c":"RP3631","n":"UNIDAD GIRATORIA P/EXTRACTOR JUGOS RP","f":"Unidad giratoria para extractor de jugos Royal Prestige","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte"},
{"c":"RP3632","n":"TAZON DEL EXTRACTOR DE JUGOS RP","f":"Tazón del extractor de jugos Royal Prestige","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, bowl, tazon, mezclar, batir, repuesto, refaccion, parte"},
{"c":"RP3633","n":"UTENSILIO P/PRESIONAR EXTRACTOR JUGOS RP","f":"Utensilio para presionar del extractor de jugos Royal Prestige","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte"},
{"c":"RP3636","n":"TAPA INTELIGENTE P/EXTRACTOR JUGOS RP","f":"Tapa inteligente para extractor de jugos Royal Prestige","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, repuesto, refaccion, parte, tapa, tapadera"},
{"c":"RP3637","n":"EMPAQUE P/COLADOR EXTRACTOR JUGOS RP","f":"Empaque para colador de extractor de jugos Royal Prestige","g":"Partes de Reemplazo","k":"extractor, juguera, jugos, juicer, colador, escurridor, strainer, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP4410","n":"VALVULA COMPLETA PARA 5Y9 CAPAS","f":"Válvula completa para 5 y 9 capas","g":"Partes de Reemplazo","k":"9 capas, repuesto, refaccion, parte, valvula, silbato"},
{"c":"RP4420","n":"MANGO LATERAL COLADOR JR 4CTS 5CPS","f":"Mango lateral de colador Junior de 4 cuartos y 5 capas","g":"Partes de Reemplazo","k":"colador, escurridor, strainer, 5 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4425","n":"MANGO LATERAL SARTEN 10\" 6Y8 CTS 5C","f":"Mango lateral para sartén de 10 pulgadas o 6 y 8 cuartos de 5 capas","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4430","n":"AGARRADERA CORTA 3&4QT/SARTEN 8\" 9CPS","f":"Agarradera corta para ollas de 3 y 4 cuartos o sartén de 8 a 9 capas","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, 9 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4435","n":"MANGO SARTEN 10\" 6Y8 QTS Y ALTA","f":"Mango de sartén de 10 pulgadas, 6 y 8 cuartos y alta","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4440","n":"AGARRADERA CORTA P/12QT 9 CAPAS","f":"Agarradera corta para olla de 12 cuartos de 9 capas","g":"Partes de Reemplazo","k":"9 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4445","n":"ASA OLLA 20QT/PAELLA 14\" 5&9 CAPAS","f":"Asa para olla de 20 cuartos o paellera de 14 pulgadas de 5 y 9 capas","g":"Partes de Reemplazo","k":"paella, sarten hondo, arrocera, tamalera, olla grande, vaporera, tamales, olla, cocinar, pot, 9 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4450","n":"AGARRADERA CORTA P/30QT 9 CAPAS","f":"Agarradera corta para olla de 30 cuartos de 9 capas","g":"Partes de Reemplazo","k":"9 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4454","n":"AGARRADERA P/TAPA-BANDEJA P/ASAR ACERO","f":"Agarradera para tapa de bandeja de acero para asar","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, mango, agarradera, handle, tapa, tapadera"},
{"c":"RP4457","n":"MANGO HERVIDOR 1QT 5 CAPAS NUEVO","f":"Mango de hervidor de 1 cuarto y 5 capas, nuevo","g":"Partes de Reemplazo","k":"tetera, pava, hervir agua, kettle, 5 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4458","n":"VALVULA COMPLETA COLOR NEGRO RP","f":"Válvula completa Royal Prestige de color negro","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, valvula, silbato"},
{"c":"RP4462","n":"MANGO P/SARTEN GOURMET DE 8\"/20CM","f":"Mango para sartén Gourmet de 8 pulgadas o 20 cm","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, gourmet, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4463","n":"MANGO P/SARTEN GOURMET DE 10\"/24CM","f":"Agarradera Royal Prestige de olla de 4 cuartos y sartén","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, gourmet, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4464","n":"MANGO P/SARTEN GOURMET DE 12\"/30CM","f":"","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, gourmet, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4475","n":"AGARRADERA LARGA 1.5&2QT 9CPS","f":"Agarradera larga para ollas de 1.5 y 2 cuartos de 9 capas","g":"Partes de Reemplazo","k":"9 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4480","n":"AGARRADERA LARGA SARTEN 8\" 9CPS","f":"Agarradera larga para sartén de 8 a 9 capas","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, 9 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4485","n":"AGARRADERA LARGA SARTEN 10\" 9CPS","f":"Agarradera larga para sartén de 10 pulgadas de 9 capas","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, 9 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4572","n":"JUNTA/MONTAJE DE LA TAPA FP3000","f":"Junta y montaje de la tapa para Frescasure 3000","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte, empaque, sello, silicon, tapa, tapadera"},
{"c":"RP4576","n":"MONTAJE/CUBIERTA FP3000 BLANCO","f":"Montaje/cubierta para Frescasure 3000, color blanco","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte"},
{"c":"RP4600","n":"CUBIERTA SUPERIOR FRESCAPURE/DUCHA","f":"Cubierta superior para Frescasure/ducha","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, filtro de ducha, regadera, shower, repuesto, refaccion, parte"},
{"c":"RP4615","n":"CONEXION GIRATORIA FP PARA LA DUCHA","f":"Conexión giratoria de Frescasure para la ducha","g":"Partes de Reemplazo","k":"filtro de ducha, regadera, shower, repuesto, refaccion, parte"},
{"c":"RP4620","n":"MANGUERA FRESCAPURE/DUCHA","f":"Manguera para Frescasure/ducha","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, filtro de ducha, regadera, shower, repuesto, refaccion, parte, manguera"},
{"c":"RP4622","n":"POSTE SUPERIOR DUCHA FRESCAPURE","f":"Poste superior de ducha Frescasure","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, filtro de ducha, regadera, shower, repuesto, refaccion, parte"},
{"c":"RP4650","n":"AGARRADERA COMPLETA P/TAPA RP","f":"Agarradera completa para tapa Royal Prestige","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, mango, agarradera, handle, tapa, tapadera"},
{"c":"RP4652","n":"MANGO LATERAL COLADOR JR 4CTS NOVEL","f":"Mango lateral de colador Junior de 4 cuartos Novel","g":"Partes de Reemplazo","k":"colador, escurridor, strainer, novel, linea novel, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4654","n":"MANGO LATERAL SARTEN 10\" 6Y8 CTS NOVEL","f":"Mango lateral para sartén de 10 pulgadas, 6 y 8 cuartos Novel","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, novel, linea novel, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4656","n":"AGARRADERA CORTA PARA 12QT RP","f":"Agarradera corta para olla de 12 cuartos Royal Prestige","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4658","n":"MANGO LATERAL PAELLERA 20CTS RP","f":"Mango lateral para paellera de 20 cuartos Royal Prestige","g":"Partes de Reemplazo","k":"paella, sarten hondo, arrocera, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4662","n":"AGARRADERA LATERAL PLANCHA DOBLE 18\"X10\" RP","f":"Agarradera lateral para plancha doble Royal Prestige de 18 x 10 pulgadas","g":"Partes de Reemplazo","k":"comal, comal doble, budare, griddle, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4664","n":"AGARRADERA LATERAL PARRILLA REDONDA 12\"/30\" RP","f":"Agarradera lateral para parrilla redonda Royal Prestige de 12 pulgadas o 30 cm","g":"Partes de Reemplazo","k":"comal redondo, grill, asador, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4670","n":"AGARRADERA LARGA 1.5CT Y 2CTS NOVEL","f":"Agarradera larga para ollas de 1.5 y 2 cuartos Novel","g":"Partes de Reemplazo","k":"novel, linea novel, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4672","n":"MANGO PLANCHA SENCILLA 11\"/25CM RP","f":"Mango para plancha sencilla Royal Prestige de 11 pulgadas o 25 cm","g":"Partes de Reemplazo","k":"comal, comal sencillo, budare, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4676","n":"MANGO P/SARTEN GOURMET 10\"/24CM NOVEL","f":"Mango para sartén Gourmet de 10 pulgadas o 24 cm Novel","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, novel, linea novel, gourmet, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4680","n":"AGARRADERA LARGA 3QT Y SARTEN 8\" NOVEL","f":"Agarradera larga para olla de 3 cuartos y sartén de 8 pulgadas Novel","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, novel, linea novel, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4682","n":"AGARRADERA LARGA SARTEN 10\" 5CPS NOVEL","f":"Agarradera larga para sartén de 10 pulgadas de 5 capas Novel","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, novel, linea novel, 5 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4777","n":"SURTIDOR ENERGIA CON ADAPTADOR BAJO MOSTRADOR","f":"","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte"},
{"c":"RP4800","n":"AGARRADERA MEDIANA PARA TAPA INNOVE","f":"Agarradera mediana para tapa Innové","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, mango, agarradera, handle, tapa, tapadera"},
{"c":"RP4801","n":"AGARRADERA GRANDE PARA TAPA INNOVE","f":"Agarradera grande para tapa Innové","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, mango, agarradera, handle, tapa, tapadera"},
{"c":"RP4802","n":"ROYAL PRESTIGE VALVULA","f":"Válvula Royal Prestige","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, valvula, silbato"},
{"c":"RP4807","n":"AGARRADERA INNOVE C/SILICON TAPA 20CM","f":"Agarradera Innové con silicona para tapa de 20 cm","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, mango, agarradera, handle, tapa, tapadera"},
{"c":"RP4808","n":"AGARRADERA INNOVE C/SILICON TAPA 24/30CM","f":"Agarradera Innové con silicona para tapa de 24 o 30 cm","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, mango, agarradera, handle, tapa, tapadera"},
{"c":"RP4810","n":"ASA LATERAL DESMONTABLE INNOVE","f":"Asa lateral desmontable Innové","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4811","n":"ASA LARGA DESMONTABLE INNOVE","f":"Asa larga desmontable Innové","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4814","n":"AGARRADERA SUPERIOR TAPA INNOVE 63CT","f":"Agarradera superior para tapa Innové 63CT","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, mango, agarradera, handle, tapa, tapadera"},
{"c":"RP4815","n":"RESORTE PARA ASA LATERAL INNOVE","f":"Resorte para asa lateral Innové","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4840","n":"RP MULTIPAN PERILLA DE SILBATO","f":"Perilla de silbato para el multiguisado Royal Prestige","g":"Partes de Reemplazo","k":"olla multiusos, vaporera, silbato, multiuso, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4842","n":"RP MULTIPAN AGARRADERA CORTA","f":"Agarradera corta para el multiguisado Royal Prestige","g":"Partes de Reemplazo","k":"olla multiusos, vaporera, silbato, multiuso, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4843","n":"RP MULTIPAN MANGO LARGO","f":"Mango largo para el multiguisado Royal Prestige","g":"Partes de Reemplazo","k":"olla multiusos, vaporera, silbato, multiuso, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4846","n":"RP MULTIPAN EMPAQUE SOLO","f":"Empaque solo para el multiguisado Royal Prestige","g":"Partes de Reemplazo","k":"olla multiusos, vaporera, silbato, multiuso, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP4848","n":"RP MULTIPAN EMPAQUE DE COLADOR","f":"Empaque de colador para el multiguisado Royal Prestige","g":"Partes de Reemplazo","k":"olla multiusos, vaporera, silbato, multiuso, colador, escurridor, strainer, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP4900","n":"ASA RP TAPA 16CM+20CM+SARTEN GOURMET 8\"","f":"Asa Royal Prestige para tapas de 16 y 20 cm y sartén Gourmet de 8 pulgadas","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, gourmet, repuesto, refaccion, parte, mango, agarradera, handle, tapa, tapadera"},
{"c":"RP4903","n":"MANGO RP PARA OLLA DE 1.5QT Y 2QT","f":"Mango Royal Prestige para olla de 1.5 y 2 cuartos","g":"Partes de Reemplazo","k":"olla, cocinar, pot, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4904","n":"MANGO RP DE OLLA 3QT Y SARTEN 8\"","f":"Mango Royal Prestige de olla de 3 cuartos y sartén de 8 pulgadas","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, olla, cocinar, pot, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4905","n":"AGARRADERA RP DE OLLA 4QT Y SARTEN 8\"","f":"Mango para sartén Gourmet de 10 pulgadas o 24 cm","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, olla, cocinar, pot, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4906","n":"MANGO RP DE SARTEN 10.5\"/26CM","f":"Mango Royal Prestige para sartén de 10.5 pulgadas o 26 cm","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4907","n":"ASA DE OLLAS 6QT/8QT Y SARTEN 10.5\"","f":"Asa para ollas de 6 y 8 cuartos y sartén de 10.5 pulgadas","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4908","n":"AGARRADERA RP PARA PAELLERA 14\"","f":"Agarradera Royal Prestige para paellera de 14 pulgadas","g":"Partes de Reemplazo","k":"paella, sarten hondo, arrocera, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4909","n":"MANGO RP PARA SARTEN GOURMET DE 8\"","f":"","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, gourmet, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4910","n":"MANGO RP PARA SARTEN GOURMET DE 10\"","f":"","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, gourmet, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4913","n":"AGARRADERA RP PARA COLADOR DE 20CM","f":"Agarradera Royal Prestige para colador de 20 cm","g":"Partes de Reemplazo","k":"colador, escurridor, strainer, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4914","n":"AGARRADERA RP PARA TAPA ALTA 26CM","f":"Agarradera Royal Prestige para tapa alta de 26 cm","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, mango, agarradera, handle, tapa, tapadera"},
{"c":"RP4920","n":"AGARRADERA RP PARA COLADOR DE 26CM","f":"Agarradera Royal Prestige para colador de 26 cm","g":"Partes de Reemplazo","k":"colador, escurridor, strainer, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP4921","n":"AGARRADERA RP PARA PAELLERA DE 10\"","f":"Agarradera Royal Prestige para paellera de 10 pulgadas","g":"Partes de Reemplazo","k":"paella, sarten hondo, arrocera, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP5405","n":"AGARRADERA COMPLETA P/TAPA 5-9 CPS","f":"Agarradera completa para tapa de 5 a 9 capas","g":"Partes de Reemplazo","k":"9 capas, repuesto, refaccion, parte, mango, agarradera, handle, tapa, tapadera"},
{"c":"RP5455","n":"MANGO DEL HERVIDOR DE 1/2QT 5 CAPAS","f":"Mango de hervidor de 1/2 cuarto y 5 capas","g":"Partes de Reemplazo","k":"tetera, pava, hervir agua, kettle, 5 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP5460","n":"AGARRADERA LARGA 1.5CT Y 2CTS 5 CAPAS","f":"Agarradera larga para ollas de 1.5 y 2 cuartos de 5 capas","g":"Partes de Reemplazo","k":"5 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP5465","n":"AGARRADERA LARGA 3QT&SARTEN 8\" 5CPS","f":"Agarradera larga para olla de 3 cuartos y sartén de 8 pulgadas de 5 capas","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, 5 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP5470","n":"STICK HANDLE 10\" SKILLET 5 PLY","f":"","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, 5 capas, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP5610","n":"MANGO - FRESCAPURE PARA LA DUCHA","f":"Mango Frescasure para la ducha","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, filtro de ducha, regadera, shower, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP6150","n":"TAPA P/CUBIERTA FP5500-6000 SOBRE MOSTRADOR","f":"Tapa para cubierta de Frescasure 5500/6000 de mostrador","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte, tapa, tapadera"},
{"c":"RP6153","n":"EMPAQUE DEL TANQUE FRESCAPURE 6000","f":"Empaque del tanque para Frescasure 6000","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP6154","n":"ABRAZADERA DEL TANQUE DEL FP6000","f":"Abrazadera del tanque del Frescasure 6000","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte"},
{"c":"RP6155","n":"TANQUE DE ACERO INOXIDABLE FP6000","f":"Tanque de acero inoxidable para Frescasure 6000","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte"},
{"c":"RP6157","n":"COLLAR DE LIBERACION DEL FP6000","f":"Collar de liberación del Frescasure 6000","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte"},
{"c":"RP6158","n":"TAPA BATERIA FP6000 SOBRE MOSTRADOR","f":"Tapa de batería para Frescasure 6000 de mostrador","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte, tapa, tapadera"},
{"c":"RP6159","n":"MONITOR DE FLUJO FP5500/FP6000","f":"Monitor de flujo Frescasure 5500/6000","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte"},
{"c":"RP6161","n":"JUEGO DEL GRIFO FP6000","f":"Juego del grifo Frescasure 6000","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte"},
{"c":"RP6163","n":"CUBIERTA INFERIOR FP5500 SOBRE MOSTRADOR","f":"Cubierta inferior de Frescasure 5500 de mostrador","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte"},
{"c":"RP6164","n":"BASE DEL FP5500 BAJO MOSTRADOR","f":"Base del Frescasure 5500 para debajo del mostrador","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte"},
{"c":"RP6165","n":"MONITOR LED PARA LLAVE DE 3 MANGUERAS","f":"Anillo LED del Frescapure 5500 bajo mostrador","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, manguera, fp5500, frescapure, led, bajo, mostrador"},
{"c":"RP6166","n":"NUEVA TAPA-CUBIERTA FP5500/FP6000","f":"Nueva tapa/cubierta para Frescasure 5500/6000","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte, tapa, tapadera"},
{"c":"RP6171","n":"MANGUERA AZUL DE 8\" FP5500/FP6000","f":"Manguera azul de 8 pulgadas para Frescasure 5500/6000","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte, manguera"},
{"c":"RP6172","n":"MANGUERA ROJA DE 12\" FP5500/FP6000","f":"Manguera roja de 12 pulgadas para Frescasure 5500/6000","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte, manguera"},
{"c":"RP6174","n":"BASE FP6000 DEBAJO DE MOSTRADOR S/LOGO","f":"Base de Frescasure 6000 para debajo del mostrador sin logo","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte"},
{"c":"RP6192","n":"EMPAQUE DEL TANQUE FP3500","f":"Empaque del tanque para Frescasure 3500","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"RP7162","n":"FP5500 UC VALVULA-T","f":"","g":"Partes de Reemplazo","k":"filtro de agua, purificador, agua, repuesto, refaccion, parte, valvula, silbato"},
{"c":"RP9700","n":"MANGO LARGO SARTEN 20CM EASY RELEASE","f":"Mango largo de sartén de 20 cm Easy Release","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, antiadherente, easy release, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP9701","n":"MANGO LATERAL SARTEN 30CM EASY RELEASE","f":"Mango lateral de sartén de 30 cm Easy Release","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, antiadherente, easy release, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP9702","n":"MANGO LARGO SARTEN 26CM EASY RELEASE","f":"Mango largo de sartén de 26 cm Easy Release","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, antiadherente, easy release, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP9703","n":"MANGO LARGO SARTEN 30CM EASY RELEASE","f":"Mango largo de sartén de 30 cm Easy Release","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, antiadherente, easy release, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP9712","n":"AGARRADERA VALVULA VIDRIO EASY RELEASE","f":"Agarradera con válvula de vidrio Easy Release","g":"Partes de Reemplazo","k":"antiadherente, easy release, repuesto, refaccion, parte, mango, agarradera, handle, valvula, silbato"},
{"c":"RP9713","n":"ARO SILICONA TAPA DE VIDRIO ER 18CM","f":"Aro de silicona para tapa de vidrio de Easy Release de 18 cm","g":"Partes de Reemplazo","k":"antiadherente, easy release, repuesto, refaccion, parte, empaque, sello, silicon, tapa, tapadera"},
{"c":"RP9714","n":"ARO SILICONA TAPA DE VIDRIO ER 20CM","f":"Aro de silicona para tapa de vidrio de Easy Release de 20 cm","g":"Partes de Reemplazo","k":"antiadherente, easy release, repuesto, refaccion, parte, empaque, sello, silicon, tapa, tapadera"},
{"c":"RP9716","n":"MANGO SARTEN 2QT-1.89L EASY RELEASE","f":"Mango de sartén de 2 cuartos o 1.89 litros Easy Release","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, antiadherente, easy release, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP9717","n":"MANGO SARTEN 3QT-2.84L EASY RELEASE","f":"Mango de sartén de 3 cuartos o 2.84 litros Easy Release","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, antiadherente, easy release, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"RP9719","n":"AGARRADERA SARTEN 3.5Q-3.31L ER","f":"","g":"Partes de Reemplazo","k":"sarten, freir, frying pan, antiadherente, easy release, repuesto, refaccion, parte, mango, agarradera, handle"},
{"c":"SP0420","n":"ARO 16CM Y VENTANA INNOVE ROJO","f":"Aro de 16 cm con ventana Innové, color rojo","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"SP0430","n":"ARO 20CM Y VENTANA INNOVE ROJO","f":"Aro de 20 cm con ventana Innové, color rojo","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"SP0440","n":"ARO 26CM Y VENTANA INNOVE ROJO","f":"Aro de 26 cm con ventana Innové, color rojo","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"SP0450","n":"ARO 30CM Y VENTANA INNOVE ROJO","f":"Aro de 30 cm con ventana Innové, color rojo","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"SP0460","n":"ARO 35CM Y VENTANA INNOVE ROJO","f":"Aro de 35 cm con ventana Innové, color rojo","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"SP0470","n":"ARO 38CM Y VENTANA INNOVE ROJO","f":"Aro de 38 cm con ventana Innové, color rojo","g":"Partes de Reemplazo","k":"innove, linea innove, repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"SP0488","n":"ARO PARA TAPA ALTA - ROJO","f":"Aro para tapa alta, color rojo","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, empaque, sello, silicon, tapa, tapadera"},
{"c":"SP2420","n":"ARO DE 16CM ROJO","f":"Aro de 16 cm, color rojo","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"SP2440","n":"ARO DE 20CM ROJO","f":"Aro de 20 cm, color rojo","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"SP2460","n":"ARO DE 26CM ROJO","f":"Aro de 26 cm, color rojo","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"SP2480","n":"ARO DE 35CM ROJO","f":"Aro de 35 cm, color rojo","g":"Partes de Reemplazo","k":"repuesto, refaccion, parte, empaque, sello, silicon"},
{"c":"CO0101","n":"RP CHOCOLATERA","f":"Chocolatera Royal Prestige","g":"Piezas con Tapa","k":"chocolate caliente, champurrado, olla chocolate"},
{"c":"CO1001","n":"RP EXPERTEA CON RECETARIO","f":"Royal Prestige Expertea","g":"Piezas con Tapa","k":"tetera, te, infusor, tea, recetario, recetas"},
{"c":"CO1453","n":"OLLA DE PRESION RP 6L & RECETARIO","f":"Olla de presión Royal Prestige de 6 litros con recetario","g":"Piezas con Tapa","k":"olla express, pressure cooker, olla pitadora, presion, olla, cocinar, pot, recetario, recetas, vaporera"},
{"c":"CO1458","n":"OLLA DE PRESION RP 10L & RECETARIO","f":"Olla de presión Royal Prestige de 10 litros con recetario","g":"Piezas con Tapa","k":"olla express, pressure cooker, olla pitadora, presion, olla, cocinar, pot, recetario, recetas, vaporera"},
{"c":"CO2106","n":"ROYAL PRESTIGE BARISTA","f":"Royal Prestige Barista","g":"Piezas con Tapa","k":"cafetera, cafe, capuchino, espumador"},
{"c":"CO2206","n":"BARISTA/BARISTART KIT","f":"Kit Barista/Baristart","g":"Piezas con Tapa","k":"cafetera, cafe, capuchino, espumador"},
{"c":"CO6130","n":"OLLA DE 1.5 CUARTOS/16CM 5 CAPAS","f":"","g":"Piezas con Tapa","k":"olla, cocinar, pot, 5 capas"},
{"c":"CO6145","n":"OLLA 4 CUARTOS/20CM C/TAPA 5CPS","f":"Olla de 4 cuartos o 20 cm con tapa de 5 capas","g":"Piezas con Tapa","k":"olla, cocinar, pot, 5 capas"},
{"c":"CO6155","n":"OLLA 8 CUARTOS/26CM C/TAPA 5CPS","f":"Olla de 8 cuartos o 26 cm con tapa de 5 capas","g":"Piezas con Tapa","k":"olla, cocinar, pot, 5 capas"},
{"c":"CO6589","n":"PAVERA OVALADA ROYAL PRESTIGE","f":"Pavera ovalada Royal Prestige","g":"Piezas con Tapa","k":"pavo, asador, horno, thanksgiving"},
{"c":"CO8070","n":"PAELLERA DE 14\"/35CM C/TAPA 5CPS","f":"Paellera de 14 pulgadas o 35 cm con tapa de 5 capas","g":"Piezas con Tapa","k":"paella, sarten hondo, arrocera, 5 capas"},
{"c":"CO8072","n":"PAELLERA DE 10\" C/TAPA 5 CAPAS","f":"Paellera de 10 pulgadas con tapa de 5 capas","g":"Piezas con Tapa","k":"paella, sarten hondo, arrocera, 5 capas"},
{"c":"CO8375","n":"OLLA 12 CUARTOS/30CM C/TAPA 9CPS","f":"Olla de 12 cuartos o 30 cm con tapa de 9 capas","g":"Piezas con Tapa","k":"tamalera, olla grande, vaporera, tamales, olla, cocinar, pot, 9 capas"},
{"c":"CO8380","n":"OLLA 20 CUARTOS/35CM C/TAPA 9CPS","f":"Olla de 20 cuartos o 35 cm con tapa de 9 capas","g":"Piezas con Tapa","k":"tamalera, olla grande, vaporera, tamales, olla, cocinar, pot, 9 capas"},
{"c":"CO8385","n":"OLLA 30 CUARTOS/38CM C/TAPA 9CPS","f":"Olla de 30 cuartos o 38 cm con tapa de 9 capas","g":"Piezas con Tapa","k":"tamalera, olla grande, vaporera, tamales, olla, cocinar, pot, 9 capas"},
{"c":"CO8650","n":"SARTEN GOURMET 8\"/20CM C/TAPA (5 CAPAS)","f":"Sartén Gourmet de 8 pulgadas o 20 cm con tapa","g":"Piezas con Tapa","k":"sarten, freir, frying pan, gourmet, 5 capas"},
{"c":"CO8655","n":"SARTEN GOURMET 10\"/25CM C/TAPA (5 CAPAS)","f":"Sartén Gourmet de 10 pulgadas o 25 cm con tapa","g":"Piezas con Tapa","k":"sarten, freir, frying pan, gourmet, 5 capas"},
{"c":"CO8660","n":"SARTEN GOURMET 12\"/30CM C/TAPA (5 CAPAS)","f":"Sartén Gourmet de 12 pulgadas o 30 cm con tapa","g":"Piezas con Tapa","k":"sarten, freir, frying pan, gourmet, 5 capas"},
{"c":"CO9079","n":"OLLA ROYAL PRESTIGE DE 60QT C/TAPA","f":"","g":"Piezas con Tapa","k":"tamalera, olla grande, vaporera, tamales, olla gigante, olla, cocinar, pot"},
{"c":"CO9222","n":"WOK INNOVE 316L CON TAPA","f":"Wok Innové 316L con tapa","g":"Piezas con Tapa","k":"comida china, saltear, stir fry, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9224","n":"OLLA DE 12QT/30CM + TAPA INNOVE 316L","f":"Olla de 12 cuartos o 30 cm con tapa Innové 316L","g":"Piezas con Tapa","k":"tamalera, olla grande, vaporera, tamales, olla, cocinar, pot, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9226","n":"OLLA INNOVE 20QT/35CM 316L CON TAPA","f":"Olla Innové de 20 cuartos o 35 cm 316L con tapa","g":"Piezas con Tapa","k":"tamalera, olla grande, vaporera, tamales, olla, cocinar, pot, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9228","n":"OLLA DE 30QT/38CM INNOVE C/TAPA 316L","f":"Olla de 30 cuartos o 38 cm Innové con tapa 316L","g":"Piezas con Tapa","k":"tamalera, olla grande, vaporera, tamales, olla, cocinar, pot, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9230","n":"SARTEN GOURMET 8\"/20CM + TAPA INNOVE 316L","f":"Sartén Gourmet de 8 pulgadas o 20 cm con tapa Innové 316L","g":"Piezas con Tapa","k":"sarten, freir, frying pan, innove, linea innove, gourmet, 316L, titanio quirurgico"},
{"c":"CO9232","n":"SARTEN GOURMET 10\"/24CM + TAPA INNOVE 316L","f":"Sartén Gourmet de 10 pulgadas o 24 cm con tapa Innové 316L","g":"Piezas con Tapa","k":"sarten, freir, frying pan, innove, linea innove, gourmet, 316L, titanio quirurgico"},
{"c":"CO9234","n":"SARTEN GOURMET 12\"/30CM + TAPA INNOVE 316L","f":"Sartén Gourmet de 12 pulgadas o 30 cm con tapa Innové 316L","g":"Piezas con Tapa","k":"sarten, freir, frying pan, innove, linea innove, gourmet, 316L, titanio quirurgico"},
{"c":"CO9236","n":"OLLA DE 4QT/20CM + TAPA INNOVE 316L","f":"Olla de 4 cuartos o 20 cm con tapa Innové 316L","g":"Piezas con Tapa","k":"olla, cocinar, pot, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9237","n":"OLLA DE 8QT/26CM + TAPA INNOVE 316L","f":"Olla de 8 cuartos o 26 cm con tapa Innové 316L","g":"Piezas con Tapa","k":"olla, cocinar, pot, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9268","n":"OLLA INNOVE 20QT 316L CON PARRILLA","f":"Olla Innové de 20 cuartos 316L con parrilla","g":"Piezas con Tapa","k":"tamalera, olla grande, vaporera, tamales, rejilla, base para tamales, olla, cocinar, pot, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9315","n":"PAELLERA + TAPA 14\"/35CM INNOVE 316L","f":"Paellera de 14 pulgadas o 35 cm con tapa Innové 316L","g":"Piezas con Tapa","k":"paella, sarten hondo, arrocera, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9317","n":"PAELLERA + TAPA 10\"/26CM INNOVE 316L","f":"Paellera de 10 pulgadas o 26 cm con tapa Innové 316L","g":"Piezas con Tapa","k":"paella, sarten hondo, arrocera, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9565","n":"OLLA NOVEL 4QT/20CM CON TAPA","f":"Olla Novel de 4 cuartos o 20 cm con tapa","g":"Piezas con Tapa","k":"olla, cocinar, pot, novel, linea novel"},
{"c":"CO9575","n":"OLLA NOVEL 8QT/26CM CON TAPA","f":"Olla Novel de 8 cuartos o 26 cm con tapa","g":"Piezas con Tapa","k":"olla, cocinar, pot, novel, linea novel"},
{"c":"CO9595","n":"PAELLERA NOVEL 10\" CON TAPA","f":"Paellera Novel de 10 pulgadas con tapa","g":"Piezas con Tapa","k":"paella, sarten hondo, arrocera, novel, linea novel"},
{"c":"CO9598","n":"PAELLERA NOVEL 14\" CON TAPA","f":"Paellera Novel de 14 pulgadas con tapa","g":"Piezas con Tapa","k":"paella, sarten hondo, arrocera, novel, linea novel"},
{"c":"CO9630","n":"SARTEN GOURMET RP 8\"/20CM C/TAPA","f":"Sartén Gourmet Royal Prestige de 8 pulgadas o 20 cm con tapa","g":"Piezas con Tapa","k":"sarten, freir, frying pan, gourmet"},
{"c":"CO9640","n":"SARTEN GOURMET RP 10\"/24CM C/TAPA","f":"Sartén Gourmet Royal Prestige de 10 pulgadas o 24 cm con tapa","g":"Piezas con Tapa","k":"sarten, freir, frying pan, gourmet"},
{"c":"CO9650","n":"SARTEN GOURMET RP 12\"/30CM C/TAPA","f":"Sartén Gourmet Royal Prestige de 12 pulgadas o 30 cm con tapa","g":"Piezas con Tapa","k":"sarten, freir, frying pan, gourmet"},
{"c":"CO9660","n":"OLLA RP DE 12QT/30CM CON TAPA","f":"Olla Royal Prestige de 12 cuartos o 30 cm con tapa","g":"Piezas con Tapa","k":"tamalera, olla grande, vaporera, tamales, olla, cocinar, pot"},
{"c":"CO9675","n":"OLLA RP DE 20QT/35CM CON TAPA","f":"Olla Royal Prestige de 20 cuartos o 35 cm con tapa","g":"Piezas con Tapa","k":"tamalera, olla grande, vaporera, tamales, olla, cocinar, pot"},
{"c":"CO9680","n":"OLLA RP DE 30QT/38CM CON TAPA","f":"Olla Royal Prestige de 30 cuartos o 38 cm con tapa","g":"Piezas con Tapa","k":"tamalera, olla grande, vaporera, tamales, olla, cocinar, pot"},
{"c":"PR2124","n":"CACEROLA ROYAL PRESTIGE","f":"Cacerola Royal Prestige","g":"Piezas con Tapa","k":"olla pequeña, saucepan"},
{"c":"PR2134","n":"KIT COMPLETO BARISTART","f":"Kit completo Baristart","g":"Piezas con Tapa","k":"cafetera, cafe, capuchino, espumador"},
{"c":"PR6100","n":"TAPA OLLA PRESION PROGRAMA UPGRADE","f":"Programa de actualización de tapa individual para olla de presión","g":"Piezas con Tapa","k":"olla express, pressure cooker, olla pitadora, presion, olla, cocinar, pot, vaporera, tapa, lid, upgrade"},
{"c":"CO1651","n":"SARTEN GOURMET 8\"/20CM - 5 CAPAS","f":"Sartén Gourmet de 8 pulgadas o 20 cm de 5 capas","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, gourmet, 5 capas"},
{"c":"CO1663","n":"SARTENES GOURMET 8, 10 Y 12\" - 5CPS","f":"Juego de sartenes Gourmet de 8, 10 y 12 pulgadas de 5 capas","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, gourmet, 5 capas"},
{"c":"CO6135","n":"OLLA DE 2 CUARTOS/16CM - 5 CAPAS","f":"Olla de 2 cuartos o 16 cm de 5 capas","g":"Piezas sin Tapa","k":"olla, cocinar, pot, 5 capas"},
{"c":"CO6140","n":"OLLA DE 3 CUARTOS/20CM - 5 CAPAS","f":"Olla de 3 cuartos o 20 cm de 5 capas","g":"Piezas sin Tapa","k":"olla, cocinar, pot, 5 capas"},
{"c":"CO6150","n":"OLLA 6 CUARTOS/26CM - 5 CAPAS","f":"Olla de 6 cuartos o 26 cm de 5 capas","g":"Piezas sin Tapa","k":"olla, cocinar, pot, 5 capas"},
{"c":"CO6156","n":"OLLA DE 8 CUARTOS/26CM - 5 CAPAS","f":"","g":"Piezas sin Tapa","k":"olla, cocinar, pot, 5 capas"},
{"c":"CO6160","n":"SARTEN 8\"/2 CUARTOS/20CM - 5 CAPAS","f":"Sartén de 8 pulgadas o 2 cuartos o 20 cm de 5 capas","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, 5 capas"},
{"c":"CO6165","n":"SARTEN 10.5\"/4 CUARTOS/26CM - 5CPS","f":"Sartén de 10.5 pulgadas o 4 cuartos o 26 cm de 5 capas","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, 5 capas"},
{"c":"CO8010","n":"SIST COCINA COMPLEMENTO 5CPS 5 PZAS","f":"Sistema de cocina complementario de 5 capas y 5 piezas","g":"Piezas sin Tapa","k":"5 capas"},
{"c":"CO8546","n":"PLANCHA DOBLE 18\"X10\" - 5 CAPAS","f":"Plancha doble de 18 x 10 pulgadas de 5 capas","g":"Piezas sin Tapa","k":"comal, comal doble, budare, griddle, 5 capas"},
{"c":"CO8547","n":"PARRILLA REDONDA 12\"/30CM - 5 CAPAS","f":"","g":"Piezas sin Tapa","k":"comal redondo, grill, asador, 5 capas"},
{"c":"CO8548","n":"PLANCHA SENCILLA (11\"/28CM) - 5 CAPAS","f":"Plancha sencilla de 11 pulgadas o 28 cm de 5 capas","g":"Piezas sin Tapa","k":"comal, comal sencillo, budare, 5 capas"},
{"c":"CO8656","n":"SARTEN GOURMET 10\"/24CM - 5 CAPAS","f":"Sartén Gourmet de 10 pulgadas o 24 cm de 5 capas","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, gourmet, 5 capas"},
{"c":"CO8661","n":"12\"/30CM GOURMET SKILLET ONLY 5 PLY","f":"","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, gourmet, 5 capas"},
{"c":"CO9201","n":"OLLA DE 2 CUARTOS/16CM INNOVE 316L","f":"Olla de 2 cuartos o 16 cm Innové 316L","g":"Piezas sin Tapa","k":"olla, cocinar, pot, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9203","n":"OLLA DE 3 CUARTOS/20CM INNOVE 316L","f":"Olla de 3 cuartos o 20 cm Innové 316L","g":"Piezas sin Tapa","k":"olla, cocinar, pot, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9205","n":"OLLA DE 4QT/20CM INNOVE 316L","f":"Olla de 4 cuartos o 20 cm Innové 316L","g":"Piezas sin Tapa","k":"olla, cocinar, pot, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9207","n":"OLLA DE 6 CUARTOS/26CM INNOVE 316L","f":"Olla de 6 cuartos o 26 cm Innové 316L","g":"Piezas sin Tapa","k":"olla, cocinar, pot, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9209","n":"OLLA DE 8 CUARTOS/26CM INNOVE 316L","f":"Olla de 8 cuartos o 26 cm Innové 316L","g":"Piezas sin Tapa","k":"olla, cocinar, pot, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9211","n":"SARTEN DE 8\"/20CM INNOVE 316L","f":"Sartén de 8 pulgadas o 20 cm Innové 316L","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9213","n":"SARTEN 10.5\"/4QT/26CM INNOVE 316L","f":"Sartén de 10.5 pulgadas o 4 cuartos o 26 cm Innové 316L","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9218","n":"PLANCHA DOBLE INNOVE 316L","f":"Plancha doble Innové 316L","g":"Piezas sin Tapa","k":"comal, comal doble, budare, griddle, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9219","n":"PLANCHA REDONDA INNOVE 316L","f":"Plancha redonda Innové 316L","g":"Piezas sin Tapa","k":"comal, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9220","n":"PLANCHA SENCILLA INNOVE 316L","f":"Plancha sencilla Innové 316L","g":"Piezas sin Tapa","k":"comal, comal sencillo, budare, innove, linea innove, 316L, titanio quirurgico"},
{"c":"CO9229","n":"SARTEN GOURMET 8\"/20CM INNOVE 316L","f":"Sartén Gourmet de 8 pulgadas o 20 cm Innové 316L","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, innove, linea innove, gourmet, 316L, titanio quirurgico"},
{"c":"CO9231","n":"SARTEN GOURMET INNOVE 316 10\"/24CM","f":"Sartén Gourmet Innové 316 de 10 pulgadas o 24 cm","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, innove, linea innove, gourmet"},
{"c":"CO9233","n":"SARTEN GOURMET 12\"/30CM 316L INNOVE","f":"Sartén Gourmet de 12 pulgadas o 30 cm 316L Innové","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, innove, linea innove, gourmet, 316L, titanio quirurgico"},
{"c":"CO9550","n":"OLLA NOVEL 1.5QT/16CM SIN TAPA","f":"Olla Novel de 1.5 cuartos o 16 cm sin tapa","g":"Piezas sin Tapa","k":"olla, cocinar, pot, novel, linea novel"},
{"c":"CO9555","n":"OLLA NOVEL 2QT/16CM SIN TAPA","f":"Olla Novel de 2 cuartos o 16 cm sin tapa","g":"Piezas sin Tapa","k":"olla, cocinar, pot, novel, linea novel"},
{"c":"CO9560","n":"OLLA NOVEL 3QT/20CM SIN TAPA","f":"Olla Novel de 3 cuartos o 20 cm sin tapa","g":"Piezas sin Tapa","k":"olla, cocinar, pot, novel, linea novel"},
{"c":"CO9570","n":"OLLA NOVEL 6QT/26CM SIN TAPA","f":"Olla Novel de 6 cuartos o 26 cm sin tapa","g":"Piezas sin Tapa","k":"olla, cocinar, pot, novel, linea novel"},
{"c":"CO9580","n":"SARTEN NOVEL 8\"/2QT/20CM SIN TAPA","f":"Sartén Novel de 8 pulgadas o 2 cuartos o 20 cm sin tapa","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, novel, linea novel"},
{"c":"CO9590","n":"SARTEN NOVEL 10.5\"/4QT/26CM SIN TAPA","f":"Sartén Novel de 10.5 pulgadas o 4 cuartos o 26 cm sin tapa","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, novel, linea novel"},
{"c":"CO9631","n":"SARTEN GOURMET RP 8\"/20CM SIN TAPA","f":"Sartén Gourmet Royal Prestige de 8 pulgadas o 20 cm sin tapa","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, gourmet"},
{"c":"CO9641","n":"SARTEN GOURMET RP 10\"/20CM SIN TAPA","f":"Sartén Gourmet Royal Prestige de 10 pulgadas o 20 cm sin tapa","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, gourmet"},
{"c":"CO9651","n":"SARTEN GOURMET RP 12\"/30CM SIN TAPA","f":"Sartén Gourmet Royal Prestige de 12 pulgadas o 30 cm sin tapa","g":"Piezas sin Tapa","k":"sarten, freir, frying pan, gourmet"},
{"c":"CO9685","n":"PLANCHA DOBLE DE 18\"X10\" RP","f":"","g":"Piezas sin Tapa","k":"comal, comal doble, budare, griddle"},
{"c":"CO9686","n":"PARRILLA REDONDA DE 12\"/30CM RP","f":"Parrilla redonda Royal Prestige de 12 pulgadas o 30 cm","g":"Piezas sin Tapa","k":"comal redondo, grill, asador"},
{"c":"CO9687","n":"PLANCHA SENCILLA (11\"/28CM) RP","f":"Plancha sencilla Royal Prestige de 11 pulgadas o 28 cm","g":"Piezas sin Tapa","k":"comal, comal sencillo, budare"},
{"c":"PR0008","n":"TABLA DE BAMBU CON BORDE SILICONA","f":"Tabla de bambú con borde de silicona","g":"Premiums","k":"tabla de picar, cortar, bambu"},
{"c":"PR0019","n":"PROTECTOR DE SARTENES 3PZS","f":"","g":"Premiums","k":"sarten, freir, frying pan, protector, guardar sartenes"},
{"c":"PR0021","n":"TABLA P/CORTAR DE BAMBU PEQ C/SILICON","f":"Tabla pequeña de bambú con silicona para cortar","g":"Premiums","k":"tabla de picar, cortar, bambu"},
{"c":"PR0025","n":"ROYAL PRESTIGE PERFECT POP","f":"Royal Prestige Perfect Pop","g":"Premiums","k":"palomitas, popcorn, crispetas, cotufas"},
{"c":"PR0109","n":"JGO CUBIERTOS AMERICAN 24PZS 18/8 US","f":"Juego de 24 piezas de cubiertos americanos de acero inoxidable 18/8","g":"Premiums","k":"cubiertos, cucharas, tenedores"},
{"c":"PR0196","n":"JGO DE UTENSILIOS DE COCINA 6PZAS","f":"Juego de utensilios de cocina de 6 piezas","g":"Premiums","k":"utensilios, servir"},
{"c":"PR1459","n":"EXPRIMIDOR DE JUGO ROYAL PRESTIGE","f":"Exprimidor de jugo Royal Prestige","g":"Premiums","k":"jugos, citricos, naranjas, exprimir"},
{"c":"PR1460","n":"3 COLADORES EXTRACTOR JUGO RP","f":"3 coladores para extractor de jugo Royal Prestige","g":"Premiums","k":"colador, escurridor, strainer"},
{"c":"PR1841","n":"AFILADOR DE CUCHILLOS RP INOX","f":"Afilador de cuchillos Royal Prestige de acero inoxidable","g":"Premiums","k":"cuchillo, knife, cortar, cuchilleria, afilar, sharpener, cuchillos"},
{"c":"PR2138","n":"CAFETERA ESPRESSO 4 TAZAS DP+","f":"","g":"Premiums","k":"cafe, greca, moka, espresso, tazas, termo"},
{"c":"PR2139","n":"CAFETERA ESPRESSO 10 TAZAS DP+","f":"","g":"Premiums","k":"cafe, greca, moka, espresso, tazas, termo"},
{"c":"PR2614","n":"MAQUINA DE ENSALADAS ROYAL PRESTIGE","f":"Máquina de ensaladas Royal Prestige","g":"Premiums","k":"cortador de verduras, rallador, ensaladas, procesador"},
{"c":"PR2675","n":"HERVIDOR 1/2 CUARTO RP MANGO NEGRO","f":"Hervidor de 1/2 cuarto Royal Prestige con mango negro","g":"Premiums","k":"tetera, pava, hervir agua, kettle"},
{"c":"PR2685","n":"HERVIDOR 1 CUARTO RP MANGO NEGRO","f":"Hervidor de 1 cuarto Royal Prestige con mango negro","g":"Premiums","k":"tetera, pava, hervir agua, kettle"},
{"c":"LT0025","n":"FOLLETO PROGRAMA 4 EN 14 ESPAÑOL","f":"Folleto del programa \"4 en 14\" en español","g":"Reclutamiento","k":"reclutamiento, oportunidad, entrenamiento"},
{"c":"LT2905","n":"LAMINAS DE VENTA NOVEL","f":"Láminas de venta Novel","g":"Reclutamiento","k":"novel, linea novel, reclutamiento, oportunidad, entrenamiento"},
{"c":"LT5300","n":"REVISTA OPORTUNIDAD ROYAL 25PK","f":"","g":"Reclutamiento","k":"reclutamiento, oportunidad, entrenamiento"},
{"c":"LT5301","n":"TRIPTICO OPORTUNIDAD ROYAL 25PK","f":"Tríptico de oportunidad Royal Prestige, paquete de 25","g":"Reclutamiento","k":"reclutamiento, oportunidad, entrenamiento"},
{"c":"LT2020","n":"TARJETAS PARA RASPAR ESP PQT 100","f":"Tarjetas para raspar en español, paquete de 100","g":"Suministros","k":"promocional, logo, suministros"},
{"c":"LT2493","n":"PORTA REGALO PAQUETE DE 10 ESP","f":"Porta regalo, paquete de 10 en español","g":"Suministros","k":"promocional, logo, suministros"},
{"c":"LT9006","n":"7 POSTERS INNOVE ESP","f":"7 posters Innové en español","g":"Suministros","k":"innove, linea innove, promocional, logo, suministros"},
{"c":"SE0027","n":"BOLSA DE PRODUCTO SM","f":"Bolsa para productos","g":"Suministros","k":"promocional, logo, suministros"},
{"c":"SE0028","n":"BOLSA DE PRODUCTO MD","f":"Bolsa de producto mediana","g":"Suministros","k":"promocional, logo, suministros"},
{"c":"SE0083","n":"RP COOLER","f":"Nevera portátil Royal Prestige","g":"Suministros","k":"hielera, nevera portatil, promocional, logo, suministros"},
{"c":"SE0091","n":"RP DIST JR PIN","f":"Pin de distribuidor Junior Royal Prestige","g":"Suministros","k":"promocional, logo, suministros, pin, insignia"},
{"c":"SE0092","n":"RP DISTRI PIN","f":"Pin de distribuidor Royal Prestige","g":"Suministros","k":"promocional, logo, suministros, pin, insignia"},
{"c":"SE0094","n":"MALETA EJECUTIVA RP LOGO","f":"Maleta ejecutiva con logo de Royal Prestige","g":"Suministros","k":"promocional, logo, suministros, maletin, presentaciones"},
{"c":"SE0193","n":"MALETIN DE NEGOCIOS RP LOGO","f":"Maletín de negocios con logo de Royal Prestige","g":"Suministros","k":"promocional, logo, suministros, maletin, presentaciones"},
{"c":"SE0371","n":"PRENDEDOR EMBAJADOR RP LOGO DORADO","f":"Prendedor de embajador con logo de Royal Prestige, color dorado","g":"Suministros","k":"promocional, logo, suministros, pin, insignia"},
{"c":"SE0373","n":"PRENDEDOR EMBAJADOR RP LOGO PLATA","f":"Prendedor de embajador con logo de Royal Prestige, color plata","g":"Suministros","k":"promocional, logo, suministros, pin, insignia"},
{"c":"SE0375","n":"PRENDEDOR DE EMPRENDEDOR RP LOGO","f":"Prendedor de emprendedor con logo de Royal Prestige","g":"Suministros","k":"promocional, logo, suministros, pin, insignia"},
{"c":"SE0376","n":"PRENDEDOR EMPRENDEDOR RP LOGO 10PK","f":"Prendedor de emprendedor con logo Royal Prestige, paquete de 10","g":"Suministros","k":"promocional, logo, suministros, pin, insignia"},
{"c":"SE0429","n":"POP SOCKET NEGRO LOGO RP PAQ 10","f":"PopSocket negro con logo Royal Prestige, paquete de 10","g":"Suministros","k":"promocional, logo, suministros"},
{"c":"SE0430","n":"ALMOHADILLA MOUSE LOGO RP PAQ 5","f":"Almohadilla para mouse con logo Royal Prestige, paquete de 5","g":"Suministros","k":"promocional, logo, suministros"},
{"c":"SE0649","n":"MANTEL RP LOGO","f":"Mantel con logo de Royal Prestige","g":"Suministros","k":"promocional, logo, suministros"},
{"c":"SE3000","n":"KIT DE PRESENTACION FRESCAFLOW","f":"Kit de presentación Frescaflow","g":"Suministros","k":"filtro de agua, purificador, agua, promocional, logo, suministros"},
{"c":"CO6516","n":"TAPA ALTA 26CM C/BASE 5Y9 CAPAS","f":"Tapa alta de 26 cm con base de 5 y 9 capas","g":"Tapas","k":"tapa, tapadera, cover, 9 capas"},
{"c":"CO6600","n":"TAPA PEQUEÑA 16CM","f":"","g":"Tapas","k":"tapa, tapadera, cover"},
{"c":"CO6605","n":"TAPA MEDIANA 20CM 5 & 9 PLY","f":"Tapa mediana de 20 cm de 5 y 9 capas","g":"Tapas","k":"tapa, tapadera, cover"},
{"c":"CO6610","n":"TAPA GRANDE DE 26CM 5Y9 CAPAS","f":"Tapa grande de 26 cm de 5 y 9 capas","g":"Tapas","k":"tapa, tapadera, cover, 9 capas"},
{"c":"CO9085","n":"TAPA PEQUEÑA INNOVE DE 16CM","f":"Tapa pequeña Innové de 16 cm","g":"Tapas","k":"tapa, tapadera, cover, innove, linea innove"},
{"c":"CO9086","n":"TAPA MEDIANA INNOVE DE 20CM","f":"","g":"Tapas","k":"tapa, tapadera, cover, innove, linea innove"},
{"c":"CO9087","n":"TAPA GRANDE INNOVE DE 26CM","f":"Tapa grande Innové de 26 cm","g":"Tapas","k":"tapa, tapadera, cover, innove, linea innove"},
{"c":"CO9088","n":"TAPA ALTA INNOVE 26CM C/REVESTIMIENTO","f":"Tapa alta Innové de 26 cm con revestimiento","g":"Tapas","k":"tapa, tapadera, cover, innove, linea innove"},
{"c":"CO9600","n":"TAPA PEQUEÑA NOVEL DE 16CM","f":"Tapa pequeña Novel de 16 cm","g":"Tapas","k":"tapa, tapadera, cover, novel, linea novel"},
{"c":"CO9605","n":"TAPA MEDIANA NOVEL DE 20CM","f":"Tapa mediana Novel de 20 cm","g":"Tapas","k":"tapa, tapadera, cover, novel, linea novel"},
{"c":"CO9610","n":"TAPA GRANDE NOVEL DE 26CM","f":"Tapa grande Novel de 26 cm","g":"Tapas","k":"tapa, tapadera, cover, novel, linea novel"},
{"c":"CO9620","n":"TAPA ALTA NOVEL 26CM C/REVESTIMIENTO","f":"Tapa alta Novel de 26 cm con revestimiento","g":"Tapas","k":"tapa, tapadera, cover, novel, linea novel"},
{"c":"CO4900","n":"RP JUEGO TAZONES P/MEZCLAR/RALLAR","f":"Juego de 5 piezas de tazones Royal Prestige para mezclar y rallar","g":"Utensilios","k":"bowl, tazon, mezclar, batir"},
{"c":"PR4902","n":"RP SET DE 3 TAZONES P/MEZCLAR","f":"Set de 3 tazones Royal Prestige para mezclar","g":"Utensilios","k":"bowl, tazon, mezclar, batir"},
{"c":"PR4904","n":"RP TAZONES P/MEZCLAR 4 PZS (2.8L)","f":"","g":"Utensilios","k":"bowl, tazon, mezclar, batir"},
{"c":"SP0091","n":"NVO JGO P/SERVIR COMPLEMENTARIO 3PZ-430SS","f":"Nuevo juego complementario de 3 piezas de acero inoxidable 430 para servir","g":"Utensilios","k":"utensilios, servir"},
{"c":"SP0095","n":"SERVIR COMPLEMENTO - SERVIDOR DE POSTRES","f":"","g":"Utensilios","k":"utensilios, servir"},
{"c":"SP0096","n":"SERVIR COMPLEMENTO - CUCHARON PARA PASTA","f":"","g":"Utensilios","k":"utensilios, servir"},
{"c":"SP0097","n":"SERVIR COMPLEMENTO - TENEDOR PARA SERVIR","f":"","g":"Utensilios","k":"utensilios, servir"},
{"c":"CR1670","n":"VASOS P/AGUA 16OZ PQT DE 4 LONDON","f":"Vasos para agua de 16 onzas, paquete de 4, modelo London","g":"Vasos y Copas","k":"vasos, cristaleria, termo"},
{"c":"CR1672","n":"VASOS CORTOS 12OZ PQT DE 4 LONDON","f":"","g":"Vasos y Copas","k":"vasos, cristaleria, termo"},
{"c":"CR2679","n":"JUEGO 4 COPAS DE VINO GALA 16OZ","f":"Juego de 4 copas de vino Gala de 16 onzas","g":"Vasos y Copas","k":"copas, vino, cristaleria"},
{"c":"CO7044","n":"SIS. COC.FAMILIAR-5CPS-10PZS C/CATL","f":"Sistema de cocina Familiar de 5 capas y 10 piezas con catálogo","g":"Mercancía","k":""},
{"c":"C09079","n":"OLLA ROYAL PRESTIGE DE 60QT C/TAPA","f":"Olla Royal Prestige de 60 cuartos con tapa","g":"Mercancía","k":"tamalera tamal"},
{"c":"C09685","n":"PLANCHA DOBLE DE 18\"X10\" RP","f":"Plancha doble Royal Prestige de 18 x 10 pulgadas","g":"Mercancía","k":"comal"},
{"c":"CO1661","n":"SARTEN \"GOURMET\"-12\"/30CM-5 CAPAS","f":"Sartén Gourmet de 12 pulgadas o 30 cm de 5 capas","g":"Mercancía","k":""},
{"c":"CO6030","n":"OLLA DE 1.5 CRTOS/16CM-5 CAPAS","f":"Olla de 1.5 cuartos o 16 cm de 5 capas","g":"Mercancía","k":""},
{"c":"CO6056","n":"OLLA DE 8 CUARTOS/26CM-5CAPAS","f":"Olla de 8 cuartos o 26 cm de 5 capas","g":"Mercancía","k":""},
{"c":"CO6547","n":"PARRILLA REDONDA-12\"/30CM-5CPAS","f":"Parrilla redonda de 12 pulgadas o 30 cm de 5 capas","g":"Mercancía","k":""},
{"c":"PR4901","n":"RP TAZONES P/ MEZCLAR 4 PZS (2.8L)","f":"Tazones Royal Prestige para mezclar de 4 piezas (2.8 litros)","g":"Premiums","k":""},
{"c":"C09086","n":"TAPA MEDIANA INNOVE DE 20CM","f":"Tapa mediana Innové de 20 cm","g":"Mercancía","k":""},
{"c":"CO6500","n":"TAPA PEQUEÑA DE 16CM-5Y9 CPAS","f":"Tapa pequeña de 16 cm de 5 y 9 capas","g":"Mercancía","k":""},
{"c":"PR2128","n":"CAFETER ESPRSSO 4 TAZAS DOBLE PARED","f":"Cafetera de espresso de 4 tazas con doble pared","g":"Premiums","k":""},
{"c":"PR2129","n":"CAFETRA ESPRESSO 10 TAZS DBLE PARED","f":"Cafetera de espresso de 10 tazas con doble pared","g":"Premiums","k":""},
{"c":"CR2672","n":"PAQUETE DE 4 VASOS DE 10 ONZAS","f":"Paquete de 4 vasos de 10 onzas","g":"Premiums","k":""},
{"c":"WF0451","n":"CARTCH DE RMPLAZO-FP 3K/3KPLUS/3500","f":"Cartucho de reemplazo para Frescasure 3000, 3000 Plus y 3500","g":"Mercancía","k":""},
{"c":"WF0500","n":"CRTCH DE RMPLAZO 4.5\" (C/ENVLTR)-CRT NSF","f":"Cartucho de reemplazo de 4.5 pulgadas con envoltorio y certificado NSF","g":"Mercancía","k":""},
{"c":"SP0362","n":"2 TAZONES BASE SILCONA C/TAPA 304SS","f":"2 tazones de acero inoxidable 304 con base de silicona y tapa","g":"Miscelaneos","k":""},
{"c":"LT2179","n":"RECETARIO OLLA DE PRESION RP","f":"Recetario de olla de presión Royal Prestige","g":"Miscelaneos","k":""},
{"c":"LT6300","n":"REVISTA PLAN DE NEGOCIO-PAQ 10PCS","f":"Revista \"Plan de Negocio\", paquete de 10 piezas","g":"Miscelaneos","k":""},
{"c":"LT2177","n":"FOLLETO DE OLLAS DE PRESIÓN ESP-ING","f":"Folleto de ollas de presión en español e inglés","g":"Miscelaneos","k":""},
{"c":"RP4470","n":"AGARR. LARGA-SARTÉN 10\" -5 CPS","f":"Agarradera larga para sartén de 10 pulgadas de 5 capas","g":"Miscelaneos","k":""},
{"c":"RP4674","n":"MANGO P/SARTÉN GOURMET 8\"/20CM-NOV","f":"Mango para sartén Gourmet de 8 pulgadas o 20 cm Novel","g":"Miscelaneos","k":""},
{"c":"RP4678","n":"MANGO P/SARTÉN GOURMET 12\"/30CM-NOV","f":"Mango para sartén Gourmet de 12 pulgadas o 30 cm Novel","g":"Miscelaneos","k":""},
{"c":"RP9718","n":"MANGOSARTEN 3.5QT-3.31L EASYREALISE","f":"Mango de sartén de 3.5 cuartos o 3.31 litros Easy Release","g":"Miscelaneos","k":""},
{"c":"RP5461","n":"MANGO-PLANCHA SENCILLA DE 11\"/25CM","f":"Mango para plancha sencilla de 11 pulgadas o 25 cm","g":"Miscelaneos","k":""},
{"c":"RP4453","n":"AGARR P/BASE-BANDEJA P/ASAR ACERO","f":"Agarradera para base de bandeja de acero para asar","g":"Miscelaneos","k":""},
{"c":"RP4461","n":"MANGO-PLANCHA SENCILLA DE 11\"/25CM","f":"Mango para plancha sencilla de 11 pulgadas o 25 cm","g":"Miscelaneos","k":""},
{"c":"RP6162","n":"VÁLVULAT FP6000 DEBAJO MOSTRADOR","f":"Válvula de Frescasure 6000 para debajo del mostrador","g":"Miscelaneos","k":""},
{"c":"RP4540","n":"MONITOR DE FLUJO FRESCAPURE 5000","f":"Monitor de flujo Frescasure 5000","g":"Miscelaneos","k":""},
{"c":"CO3017","n":"RP ELITE 3.5QT SAUTE PAN ONLY","f":"Royal Prestige Elite sartén para saltear de 3.5 cuartos (solo)","g":"Mercancía","k":""},
{"c":"CO3018","n":"RP ELITE 4QT DUTCH OVEN","f":"Royal Prestige Elite horno holandés de 4 cuartos","g":"Mercancía","k":""}
];

const ESTADOS_IMPUESTO = {"AL":["Alabama",9.44],"AK":["Alaska",1.82],"AZ":["Arizona",8.52],"AR":["Arkansas",9.48],"CA":["California",8.99],"CO":["Colorado",7.86],"CT":["Connecticut",6.35],"DE":["Delaware",0.0],"FL":["Florida",7.02],"GA":["Georgia",7.43],"HI":["Hawaii",4.5],"ID":["Idaho",6.03],"IL":["Illinois",8.96],"IN":["Indiana",7.0],"IA":["Iowa",6.94],"KS":["Kansas",8.69],"KY":["Kentucky",6.0],"LA":["Louisiana",10.11],"ME":["Maine",5.5],"MD":["Maryland",6.0],"MA":["Massachusetts",6.25],"MI":["Michigan",6.0],"MN":["Minnesota",8.04],"MS":["Mississippi",7.07],"MO":["Missouri",8.29],"MT":["Montana",0.0],"NE":["Nebraska",6.95],"NV":["Nevada",8.24],"NH":["New Hampshire",0.0],"NJ":["New Jersey",6.63],"NM":["New Mexico",7.63],"NY":["New York",8.54],"NC":["North Carolina",7.0],"ND":["North Dakota",7.04],"OH":["Ohio",7.24],"OK":["Oklahoma",9.06],"OR":["Oregon",0.0],"PA":["Pennsylvania",6.34],"RI":["Rhode Island",7.0],"SC":["South Carolina",7.49],"SD":["South Dakota",6.11],"TN":["Tennessee",9.61],"TX":["Texas",8.25],"UT":["Utah",7.25],"VT":["Vermont",6.24],"VA":["Virginia",5.77],"WA":["Washington",9.47],"WV":["West Virginia",6.57],"WI":["Wisconsin",5.72],"WY":["Wyoming",5.56],"DC":["Washington DC",6.0],"PR":["Puerto Rico",11.5]};

const TC = {
  bg:"#f0f2f5", panel:"#ffffff", border:"#d0d4dc", borderHi:"#b8cae8",
  blue:"#1a3a6b", blueMid:"#2756a8", blueLight:"#4a7fd4", bluePale:"#e8edf8",
  red:"#c0392b", text:"#2c2c2c", mut:"#8a8a8a",
  serif:"'Playfair Display', serif",
  glow:"0 2px 12px rgba(26,58,107,.10)", glowLg:"0 6px 28px rgba(26,58,107,.14)",
};
const fmtC = (n) => "$" + Number(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const CATS_RP = Array.from(new Set(CATALOGO_RP.map(p=>p.g))).sort((a,b)=>a.localeCompare(b,"es"));

const sinAcentos = (t) => (t||"").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// Grupos que van AL FINAL de los resultados (la mercadería siempre primero)
const GRUPOS_SECUNDARIOS = ["Premiums","Miscelaneos","Literatura de Venta","Materiales Clientes","Suministros","Ordenes de Compra","Reclutamiento","Kits Novato"];
// Catálogo base + cambios del equipo (agregados / editados / eliminados)
function catalogoConCustom(custom){
  const c = custom || {};
  const elim = new Set(c.eliminados || []);
  const edit = c.editados || {};
  const base = CATALOGO_RP.filter(p=>!elim.has(p.c)).map(p=>edit[p.c] ? {...p, ...edit[p.c]} : p);
  const agregados = (c.agregados || []).filter(p=>!elim.has(p.c)).map(p=>({...p, _custom:true}));
  return [...base, ...agregados];
}
function filtrarCatalogo(q, cat, custom){
  // Búsqueda ABIERTA: cada palabra puede aparecer en cualquier parte del
  // producto (código, nombre, descripción o palabras clave), sin acentos.
  // "presion 10" encuentra "Olla de presión de 10 litros".
  const toks = sinAcentos(q).trim().split(/\s+/).filter(Boolean);
  const out = catalogoConCustom(custom).filter(p=>{
    if(cat!=="ALL" && p.g!==cat) return false;
    if(!toks.length) return true;
    const hay = sinAcentos([p.c,p.n,p.f,p.k].filter(Boolean).join(" "));
    return toks.every(t=>hay.includes(t));
  });
  // Mercadería primero; premios, misceláneos y materiales internos al final
  return out.sort((a,b)=>(GRUPOS_SECUNDARIOS.includes(a.g)?1:0)-(GRUPOS_SECUNDARIOS.includes(b.g)?1:0));
}

function copiarTexto(txt, ok){
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(txt).then(ok).catch(()=>{ fallbackCopy(txt); ok(); });
    } else { fallbackCopy(txt); ok(); }
  }catch(e){ try{ fallbackCopy(txt); }catch(e2){} ok(); }
}
function fallbackCopy(txt){
  const ta=document.createElement("textarea");
  ta.value=txt; ta.style.position="fixed"; ta.style.opacity="0";
  document.body.appendChild(ta); ta.focus(); ta.select();
  document.execCommand("copy"); document.body.removeChild(ta);
}

/* ── Lista de productos (compartida por ambas pestañas) ── */
function ListaProductos({ items, limite, sel, onPick, copiado, onEditar, onEliminar }){
  const mostrar = items.slice(0, limite);
  return (
    <div className="rounded-xl overflow-y-auto" style={{border:"1px solid "+TC.border, maxHeight:420, background:"#fff"}}>
      {mostrar.length===0 && (
        <div className="text-center py-10" style={{color:TC.mut}}>
          <div className="mb-2 flex justify-center"><Ico e="🔍" size={30} strokeWidth={1.25} className="opacity-40" /></div>
          <div className="text-sm font-bold">Sin resultados. Prueba otra palabra o código.</div>
        </div>
      )}
      {mostrar.map((p,i)=>(
        <button key={p.c+"-"+i} onClick={()=>onPick(p)}
          className="w-full text-left flex items-start gap-3 px-3 py-3 transition active:scale-[.99]"
          style={{borderBottom:i<mostrar.length-1?"1px solid "+TC.bg:"none", background: sel&&sel.c===p.c ? TC.bluePale : "#fff", borderLeft: sel&&sel.c===p.c ? "3px solid "+TC.blueMid : "3px solid transparent"}}>
          <span className="text-[11px] font-black px-2 py-1 rounded-md whitespace-nowrap" style={{background: copiado===p.c ? "#1d8a4f" : TC.blue, color:"#fff", letterSpacing:".04em"}}>
            {copiado===p.c ? <><Ico e="✓" className="mr-1" />Copiado</> : p.c}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-[13px] font-bold leading-snug" style={{color:TC.text}}>{p.f || p.n}</span>
            {p.f && p.f!==p.n && <span className="block text-[10px] mt-0.5" style={{color:TC.mut}}>{p.n}</span>}
            <span className="block text-[10px] font-black uppercase mt-0.5" style={{color:TC.blueMid, letterSpacing:".08em"}}>{p.g}{p._custom?" · ✳️ agregado por el equipo":""}</span>
          </span>
          {(onEditar||onEliminar) && (
            <span className="flex gap-1 shrink-0" onClick={e=>e.stopPropagation()}>
              {onEditar && <span role="button" onClick={()=>onEditar(p)} className="w-7 h-7 flex items-center justify-center rounded-lg text-xs" style={{background:TC.bg, border:"1px solid "+TC.border}}><Ico e="✏" /></span>}
              {onEliminar && <span role="button" onClick={()=>onEliminar(p)} className="w-7 h-7 flex items-center justify-center rounded-lg text-xs" style={{background:"#fef2f2", border:"1px solid #fecaca"}}><Ico e="🗑" /></span>}
            </span>
          )}
        </button>
      ))}
      {items.length>limite && (
        <div className="px-3 py-3 text-center text-xs italic" style={{color:TC.mut}}>+ {items.length-limite} más — refina tu búsqueda</div>
      )}
    </div>
  );
}

/* ── Filtros de categoría (chips con scroll horizontal, amigable iPhone) ── */
function ChipsCategorias({ cat, setCat }){
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 mb-2" style={{WebkitOverflowScrolling:"touch"}}>
      <button onClick={()=>setCat("ALL")} className="px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap transition"
        style={cat==="ALL"?{background:TC.blueMid,color:"#fff",border:"1.5px solid "+TC.blueMid}:{background:TC.bg,color:"#5a5a5a",border:"1.5px solid "+TC.border}}>Todos</button>
      {CATS_RP.map(c=>(
        <button key={c} onClick={()=>setCat(c)} className="px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap transition"
          style={cat===c?{background:TC.blueMid,color:"#fff",border:"1.5px solid "+TC.blueMid}:{background:TC.bg,color:"#5a5a5a",border:"1.5px solid "+TC.border}}>{c}</button>
      ))}
    </div>
  );
}

/* ══════════ PESTAÑA 1: BUSCADOR DE CÓDIGOS ══════════ */
function BuscadorCodigos({ catalogoCustom, setCatalogoCustom, puedeEditar }){
  const [q,setQ]=useState("");
  const [cat,setCat]=useState("ALL");
  const [copiado,setCopiado]=useState(null);
  const [prodForm,setProdForm]=useState(null); // null | {c,n,f,g,k,_esNuevo,_original}
  const items = useMemo(()=>filtrarCatalogo(q,cat,catalogoCustom),[q,cat,catalogoCustom]);
  const totalCat = useMemo(()=>catalogoConCustom(catalogoCustom).length,[catalogoCustom]);
  const pick=(p)=>{ copiarTexto(p.c, ()=>{ setCopiado(p.c); setTimeout(()=>setCopiado(c=>c===p.c?null:c),1600); }); };
  const abrirNuevoProd=()=>setProdForm({c:"",n:"",f:"",g:"Mercancía",k:"",_esNuevo:true});
  const abrirEditarProd=(p)=>setProdForm({c:p.c,n:p.n||"",f:p.f||"",g:p.g||"Mercancía",k:p.k||"",_esNuevo:false,_original:p.c,_custom:!!p._custom});
  const guardarProd=()=>{
    const f=prodForm;
    if(!(f.c||"").trim() || !(f.n||"").trim()){ alert("✍️ Código y nombre son obligatorios."); return; }
    const cod=f.c.trim().toUpperCase();
    if(f._esNuevo && catalogoConCustom(catalogoCustom).some(p=>p.c===cod)){ alert("⚠️ Ese código ya existe en el catálogo."); return; }
    setCatalogoCustom(prev=>{
      const cc={ agregados:[...((prev||{}).agregados||[])], editados:{...((prev||{}).editados||{})}, eliminados:[...((prev||{}).eliminados||[])] };
      const datos={ c:cod, n:f.n.trim(), f:(f.f||"").trim(), g:f.g||"Mercancía", k:(f.k||"").trim() };
      if(f._esNuevo){
        cc.agregados.push(datos);
      } else if(f._custom){
        cc.agregados = cc.agregados.map(p=>p.c===f._original?datos:p);
      } else {
        cc.editados[f._original]=datos; // el original queda respaldado; se muestra la versión editada
      }
      cc.eliminados = cc.eliminados.filter(x=>x!==cod);
      return cc;
    });
    setProdForm(null);
  };
  const eliminarProd=(p)=>{
    if(!confirm(`¿Quitar "${p.n}" (${p.c}) del buscador?`)) return;
    setCatalogoCustom(prev=>{
      const cc={ agregados:[...((prev||{}).agregados||[])], editados:{...((prev||{}).editados||{})}, eliminados:[...((prev||{}).eliminados||[])] };
      if(p._custom) cc.agregados = cc.agregados.filter(x=>x.c!==p.c);
      else if(!cc.eliminados.includes(p.c)) cc.eliminados.push(p.c);
      delete cc.editados[p.c];
      return cc;
    });
  };
  return (
    <div className="max-w-2xl mx-auto space-y-3">
      <div className="rounded-2xl p-5" style={{background:TC.panel, border:"1px solid "+TC.border, boxShadow:TC.glow}}>
        <div className="text-lg font-bold" style={{fontFamily:TC.serif, color:TC.blue}}>Buscador de Códigos</div>
        <div className="flex items-center justify-between mb-4 gap-2">
          <div className="text-xs" style={{color:TC.mut}}>{totalCat} productos · Toca un producto para copiar su código</div>
          {puedeEditar && <button onClick={abrirNuevoProd} className="shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-black text-white" style={{background:TC.blueMid}}>+ Producto</button>}
        </div>
        <div className="relative mb-2">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-base" style={{color:TC.blueLight}}>⌕</span>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Buscar: tamalera, sartén, CO9846…" inputMode="search"
            className="w-full rounded-lg pl-9 pr-3 py-2.5 text-sm font-semibold outline-none"
            style={{background:TC.bg, border:"2px solid "+TC.border, color:"#111"}} />
        </div>
        <ChipsCategorias cat={cat} setCat={setCat} />
        <div className="text-xs font-bold mb-2" style={{color:TC.mut}}>{items.length} producto{items.length!==1?"s":""}</div>
        <ListaProductos items={items} limite={100} sel={null} onPick={pick} copiado={copiado} onEditar={puedeEditar?abrirEditarProd:null} onEliminar={puedeEditar?eliminarProd:null} />
      </div>
      {prodForm && (
        <Modal title={prodForm._esNuevo?<><Ico e="➕" className="mr-1" />Nuevo producto</>:<><Ico e="✏" className="mr-1" />Editar producto</>} onClose={()=>setProdForm(null)}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Código" required><input className={inpLight} value={prodForm.c} onChange={e=>setProdForm(p=>({...p,c:e.target.value}))} placeholder="CO9846" autoCapitalize="characters" /></Field>
            <Field label="Categoría"><select className={inpLight} value={prodForm.g} onChange={e=>setProdForm(p=>({...p,g:e.target.value}))}>{CATS_RP.map(c=><option key={c} value={c}>{c}</option>)}</select></Field>
          </div>
          <Field label="Nombre del producto" required><input className={inpLight} value={prodForm.n} onChange={e=>setProdForm(p=>({...p,n:e.target.value}))} placeholder="OLLA DE PRESIÓN 10 LTS" /></Field>
          <Field label="Descripción (opcional)"><input className={inpLight} value={prodForm.f} onChange={e=>setProdForm(p=>({...p,f:e.target.value}))} placeholder="Olla de presión Royal Prestige de 10 litros" /></Field>
          <Field label="Palabras clave (separadas por coma)"><input className={inpLight} value={prodForm.k} onChange={e=>setProdForm(p=>({...p,k:e.target.value}))} placeholder="presion, olla grande, pressure cooker" /></Field>
          <button onClick={guardarProd} className="w-full py-3 rounded-xl text-sm font-bold text-white mt-1" style={{background:RP.navy}}><Ico e="✅" className="mr-1.5" />Guardar producto</button>
        </Modal>
      )}
    </div>
  );
}

/* ══════════ PESTAÑA 2: SIMULADOR DE COMPRA (réplica exacta de la app web v8) ══════════ */
function SimuladorCompra(){
  const [precio,setPrecio]=useState("");
  const [estado,setEstado]=useState("TX");
  const [envio,setEnvio]=useState("");
  const [envioManual,setEnvioManual]=useState(false);
  const [depPct,setDepPct]=useState(5);
  const [depAmt,setDepAmt]=useState("");
  const [depMode,setDepMode]=useState("pct"); // 'pct' | 'amt'
  const [balance,setBalance]=useState("");
  const [pagoCustom,setPagoCustom]=useState("");

  /* ── Cálculo (misma lógica que la app web) ── */
  const nPrecio=parseFloat(precio)||0;
  const nEnvio=parseFloat(envio)||0;
  const nBalance=parseFloat(balance)||0;
  const tasa=(ESTADOS_IMPUESTO[estado]?ESTADOS_IMPUESTO[estado][1]:0)/100;
  const subtotal=nPrecio+nEnvio;
  const impuesto=subtotal*tasa;
  const totalVenta=subtotal+impuesto;
  // Depósito: base = Total de Venta SOLAMENTE (el balance NO afecta el depósito)
  const deposito = depMode==="amt" ? (parseFloat(depAmt)||0) : totalVenta*((parseFloat(depPct)||0)/100);
  const pctReal = totalVenta>0 ? (deposito/totalVenta)*100 : 0;
  const financeSub = Math.max(0, totalVenta-deposito);
  const financeTotal = financeSub + nBalance;

  const cambiarPrecio=(v)=>{
    setPrecio(v);
    const p=parseFloat(v)||0;
    if(!envioManual) setEnvio(p>0?(p*0.05).toFixed(2):"");
  };
  const cambiarEnvio=(v)=>{ setEnvio(v); setEnvioManual(true); };
  const setPctSync=(v)=>{ const x=Math.min(100,Math.max(0,parseFloat(v)||0)); setDepPct(x); setDepMode("pct"); };
  const setAmtSync=(v)=>{ setDepAmt(v); setDepMode("amt"); };

  // Sincronización visual de los 3 controles
  const pctMostrar = depMode==="pct" ? depPct : pctReal;
  const amtMostrar = depMode==="amt" ? depAmt : (deposito>0?deposito.toFixed(2):"");

  /* Planes fijos: pago mensual = financeTotal × factor; total = pago×meses + depósito */
  const planes=[
    {meses:32, factor:0.04, destaca:true},
    {meses:24, factor:0.05},
    {meses:16, factor:0.07},
    {meses:12, factor:0.09},
  ].map(pl=>({...pl, pago:financeTotal*pl.factor, total:financeTotal*pl.factor*pl.meses+deposito}));

  /* Pago personalizado — amortización 1.5% mensual sobre saldo decreciente */
  const custom=useMemo(()=>{
    const pago=parseFloat(pagoCustom)||0;
    const RATE=0.015, MAX=600;
    if(financeTotal<=0 || pago<=0) return null;
    if(pago<=financeTotal*RATE) return {infinito:true};
    let saldo=financeTotal, meses=0, totalPagado=0, totalInteres=0, ultimo=0;
    while(saldo>0.005 && meses<MAX){
      const interes=saldo*RATE;
      totalInteres+=interes; saldo+=interes; meses++;
      if(saldo<=pago){ ultimo=saldo; totalPagado+=saldo; saldo=0; }
      else { totalPagado+=pago; saldo-=pago; ultimo=pago; }
    }
    return {meses, ultimo, totalPagado:totalPagado+deposito, totalInteres};
  },[pagoCustom, financeTotal, deposito]);

  const Fila=({l,v,strong,pale,neg})=>(
    <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={pale?{background:TC.bluePale}:{}}>
      <span className={"text-[13px] "+(strong?"font-black":"font-semibold")} style={{color:strong?TC.blue:"#5a5a5a"}}>{l}</span>
      <span className={"text-[14px] "+(strong?"font-black":"font-bold")} style={{color:neg?TC.red:(strong?TC.blue:TC.text)}}>{v}</span>
    </div>
  );
  const inp={background:"#fff", border:"2px solid "+TC.border, color:"#111"};

  return (
    <div className="max-w-2xl mx-auto space-y-3">
      {/* CONFIGURA TU COMPRA */}
      <div className="rounded-2xl p-5 space-y-4" style={{background:TC.panel, border:"1px solid "+TC.border, boxShadow:TC.glow}}>
        <div>
          <div className="text-lg font-bold" style={{fontFamily:TC.serif, color:TC.blue}}>Configura tu Compra</div>
          <div className="text-xs" style={{color:TC.mut}}>Ingresa los datos para calcular el financiamiento</div>
        </div>
        <div>
          <label className="block text-[13px] font-black mb-1.5" style={{color:TC.text}}>Precio del Producto</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 font-black" style={{color:TC.blueMid}}>$</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={precio} onChange={e=>cambiarPrecio(e.target.value)} placeholder="0.00"
              className="w-full rounded-lg pl-7 pr-3 py-2.5 text-base font-bold outline-none" style={inp} />
          </div>
        </div>
        <div>
          <label className="block text-[13px] font-black mb-1.5" style={{color:TC.text}}>Estado de Envío</label>
          <select value={estado} onChange={e=>setEstado(e.target.value)} className="w-full rounded-lg px-3 py-2.5 text-sm font-bold outline-none" style={inp}>
            {Object.entries(ESTADOS_IMPUESTO).sort((a,b)=>a[1][0].localeCompare(b[1][0])).map(([k,[n,r]])=>(
              <option key={k} value={k}>{n} ({r.toFixed(2)}%)</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[13px] font-black mb-1.5" style={{color:TC.text}}>Costo de Envío <span className="font-normal text-xs" style={{color:TC.mut}}>(promedio 5%, editable)</span></label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 font-black" style={{color:TC.blueMid}}>$</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={envio} onChange={e=>cambiarEnvio(e.target.value)} placeholder="0.00"
              className="w-full rounded-lg pl-7 pr-3 py-2.5 text-base font-bold outline-none" style={inp} />
          </div>
          <div className="text-[11px] mt-1" style={{color:TC.mut}}>Se calcula automático al 5% del precio · puedes editarlo</div>
        </div>
        <div>
          <label className="block text-[13px] font-black mb-1.5" style={{color:TC.text}}>Depósito Inicial <span className="font-normal text-xs" style={{color:TC.mut}}>(sugerido 5%)</span></label>
          <div className="inline-block text-[13px] font-black text-white px-3 py-1 rounded-md mb-2" style={{background:TC.blue}}>{Math.round(pctMostrar)}% · {fmtC(deposito)}</div>
          <input type="range" min="0" max="100" step="1" value={Math.min(100,Math.round(pctMostrar))} onChange={e=>setPctSync(e.target.value)} className="w-full" style={{accentColor:TC.blueMid}} />
          <div className="grid grid-cols-2 gap-2 mt-1">
            <div>
              <label className="block text-[11px] font-black mb-1" style={{color:TC.text}}>Porcentaje (%)</label>
              <input type="number" inputMode="decimal" min="0" max="100" step="1" value={depMode==="pct"?depPct:pctReal.toFixed(1)} onChange={e=>setPctSync(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-sm font-bold outline-none" style={inp} />
            </div>
            <div>
              <label className="block text-[11px] font-black mb-1" style={{color:TC.text}}>Monto ($)</label>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm font-black" style={{color:TC.blueMid}}>$</span>
                <input type="number" inputMode="decimal" min="0" step="0.01" value={amtMostrar} onChange={e=>setAmtSync(e.target.value)} placeholder="0.00"
                  className="w-full rounded-lg pl-6 pr-2 py-2 text-sm font-bold outline-none" style={inp} />
              </div>
            </div>
          </div>
          <div className="text-[11px] mt-1" style={{color:TC.mut}}>Slider · % · o monto en $ — los tres se sincronizan</div>
        </div>
        <div>
          <label className="block text-[13px] font-black mb-1.5" style={{color:TC.text}}>Balance Pendiente <span className="font-normal text-xs" style={{color:TC.mut}}>(deuda anterior del cliente)</span></label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 font-black" style={{color:TC.blueMid}}>$</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={balance} onChange={e=>setBalance(e.target.value)} placeholder="0.00"
              className="w-full rounded-lg pl-7 pr-3 py-2.5 text-base font-bold outline-none" style={inp} />
          </div>
          <div className="text-[11px] mt-1" style={{color:TC.mut}}>Se suma al monto a financiar después del depósito</div>
        </div>
      </div>

      {/* RESUMEN DE INVERSIÓN */}
      <div className="rounded-2xl p-5" style={{background:TC.panel, border:"2px solid "+TC.blue, boxShadow:TC.glowLg}}>
        <div className="text-center mb-4">
          <div className="text-xl font-black" style={{fontFamily:TC.serif, color:TC.blue}}>Resumen de Inversión</div>
          <div className="text-[11px] tracking-[.4em]" style={{color:TC.blueLight}}>◆ ◆ ◆</div>
        </div>
        <div className="space-y-1">
          <Fila l="Precio del producto" v={fmtC(nPrecio)} />
          <Fila l="Costo de envío" v={fmtC(nEnvio)} />
          <Fila l="Subtotal" v={fmtC(subtotal)} />
          <Fila l={"Impuesto ("+(tasa*100).toFixed(2)+"%)"} v={fmtC(impuesto)} />
          <Fila l="Total de Venta" v={fmtC(totalVenta)} strong />
          <Fila l={"Depósito inicial ("+pctReal.toFixed(1)+"%)"} v={"− "+fmtC(deposito)} pale />
          <Fila l="Monto a financiar (venta)" v={fmtC(financeSub)} pale />
          {nBalance>0 && <Fila l="Balance pendiente" v={"+ "+fmtC(nBalance)} neg />}
          <Fila l="Monto Total a Financiar" v={fmtC(financeTotal)} strong pale />
        </div>

        <div className="text-[11px] font-black uppercase tracking-widest mt-5 mb-2" style={{color:TC.mut}}>Opciones de Financiamiento</div>
        <div className="grid grid-cols-2 gap-2">
          {planes.map(pl=>(
            <div key={pl.meses} className="rounded-xl p-3 text-center relative" style={pl.destaca?{border:"2px solid "+TC.blueMid, background:TC.bluePale}:{border:"1px solid "+TC.border, background:"#fff"}}>
              {pl.destaca && <div className="text-[9px] font-black uppercase tracking-wider" style={{color:TC.blueMid}}><Ico e="★" className="mr-1.5" />Recomendado</div>}
              <div className="text-[12px] font-black" style={{color:TC.text}}>{pl.meses} Meses</div>
              <div className="text-xl font-black my-0.5" style={{fontFamily:TC.serif, color:TC.blue}}>{fmtC(pl.pago)}<span className="text-[10px] font-bold ml-1" style={{color:TC.mut}}>por mes</span></div>
              <div className="text-[10px]" style={{color:TC.mut}}>Total a pagar: <b style={{color:TC.text}}>{fmtC(pl.total)}</b></div>
            </div>
          ))}
        </div>

        {/* PAGO MENSUAL PERSONALIZADO */}
        <div className="text-[11px] font-black uppercase tracking-widest mt-5 mb-2" style={{color:TC.mut}}>Pago Mensual Personalizado</div>
        <div className="rounded-xl p-4" style={{background:TC.bg, border:"1px solid "+TC.border}}>
          <label className="block text-[13px] font-black mb-1.5" style={{color:TC.text}}>¿Cuánto puedes pagar al mes?</label>
          <div className="relative mb-3">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 font-black" style={{color:TC.blueMid}}>$</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={pagoCustom} onChange={e=>setPagoCustom(e.target.value)} placeholder="0.00"
              className="w-full rounded-lg pl-7 pr-3 py-2.5 text-base font-bold outline-none" style={inp} />
          </div>
          <div className="rounded-xl p-4 text-center" style={{background:"#fff", border:"2px solid "+(custom&&custom.infinito?TC.red:TC.blue)}}>
            <div className="text-[10px] font-black uppercase tracking-widest mb-1" style={{color:TC.mut}}>Meses exactos para liquidar</div>
            <div className="text-3xl font-black" style={{fontFamily:TC.serif, color:custom&&custom.infinito?TC.red:TC.blue}}>
              {!custom ? "—" : custom.infinito ? "∞" : custom.meses+" mes"+(custom.meses!==1?"es":"")}
            </div>
            {custom && custom.infinito && <div className="text-[11px] mt-1 font-bold" style={{color:TC.red}}>El pago no cubre los intereses</div>}
            {custom && !custom.infinito && (
              <div className="grid grid-cols-3 gap-2 mt-3 text-left">
                <div><div className="text-[9px] font-black uppercase" style={{color:TC.mut}}>Último pago</div><div className="text-[12px] font-black" style={{color:TC.text}}>{fmtC(custom.ultimo)}</div></div>
                <div><div className="text-[9px] font-black uppercase" style={{color:TC.mut}}>Total pagado</div><div className="text-[12px] font-black" style={{color:TC.text}}>{fmtC(custom.totalPagado)}</div></div>
                <div><div className="text-[9px] font-black uppercase" style={{color:TC.mut}}>Intereses</div><div className="text-[12px] font-black" style={{color:TC.text}}>{fmtC(custom.totalInteres)}</div></div>
              </div>
            )}
          </div>
          <div className="text-[10px] mt-2 text-center" style={{color:TC.mut}}>Interés simulado: 1.5% mensual sobre saldo decreciente</div>
        </div>
        <div className="text-[10px] mt-3 text-center italic" style={{color:TC.mut}}>Los montos son una estimación con fines informativos. Los impuestos pueden variar según condado.</div>
      </div>
    </div>
  );
}

return { BuscadorCodigos, SimuladorCompra };
})();
const BuscadorCodigos = __CatalogoModule.BuscadorCodigos;
const SimuladorCompra = __CatalogoModule.SimuladorCompra;

const NAV=[{id:"inicio",icon:"🏠",label:"Inicio"},{id:"llamadas",icon:"📞",label:"Llamadas"},{id:"agenda",icon:"📅",label:"Agenda"},{id:"servicio",icon:"🔧",label:"Servicios"},{id:"agregados",icon:"📂",label:"Agregados"},{id:"referidos",icon:"🎁",label:"Referidos"},{id:"prospectos",icon:"🔍",label:"Prospección"},{id:"distribucion",icon:"🏠",label:"Distribución"},{id:"reclutamiento",icon:"🧲",label:"Reclutamiento"},{id:"cobranza",icon:"💵",label:"Cobranza"},{id:"catalogo",icon:"🔎",label:"Buscador de Códigos"},{id:"simulador",icon:"🧮",label:"Simulador de Compra"},{id:"rutas",icon:"🗺️",label:"Rutas"},{id:"cumpleanos",icon:"🎂",label:"Cumpleaños"},{id:"incentivo",icon:"🏆",label:"Incentivos"},{id:"control",icon:"📈",label:"Control de actividad"},{id:"stats",icon:"📊",label:"Estadísticas"},{id:"config",icon:"⚙️",label:"Configuración"}];

// Las 4 secciones que se agrupan bajo la pestaña desplegable "Base de datos"
const DB_TABS=["agregados","referidos","prospectos","distribucion"];

// ─── MODAL DE REVISIÓN EDITABLE DE REFERIDOS ──────────────────
function RefReviewModal({ records, onSave, onClose }) {
  const [items,setItems]=useState(()=>records.map(r=>({
    id: genId(),
    anfitrion: r.anfitrion||"",
    regalo: r.regalo||"",
    anfitrion_telefono: r.anfitrion_telefono||"",
    anfitrion_ciudad: r.anfitrion_ciudad||"",
    anfitrion_cuenta: r.anfitrion_cuenta||"",
    anfitrion_detalle: r.anfitrion_detalle||"",
    estado:"sin_estado", venta:false, creado:new Date().toISOString(),
    referidos:(r.referidos||[]).map(x=>({nombre:x.nombre||"",parentesco:x.parentesco||"",telefono:x.telefono||"",direccion:x.direccion||"",producto:x.producto||"",observaciones:x.observaciones||"",detalles:"",estado:"sin_estado",historial:[]})),
  })));

  const setAnf=(ai,patch)=>setItems(p=>p.map((a,i)=>i===ai?{...a,...patch}:a));
  const setRef=(ai,ri,patch)=>setItems(p=>p.map((a,i)=>i!==ai?a:{...a,referidos:a.referidos.map((r,j)=>j===ri?{...r,...patch}:r)}));
  const addRef=(ai)=>setItems(p=>p.map((a,i)=>i!==ai?a:{...a,referidos:[...a.referidos,{nombre:"",parentesco:"",telefono:"",direccion:"",producto:"",observaciones:"",detalles:"",estado:"sin_estado",historial:[]}]}));
  const delRef=(ai,ri)=>setItems(p=>p.map((a,i)=>i!==ai?a:{...a,referidos:a.referidos.filter((_,j)=>j!==ri)}));
  const delAnf=(ai)=>setItems(p=>p.filter((_,i)=>i!==ai));

  const totalRefs=items.reduce((a,anf)=>a+anf.referidos.length,0);
  const inp="w-full border border-[#e5def4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#5b21b6]";

  return (
    <Modal title="🎁 Revisar referidos antes de guardar" onClose={onClose}>
      <div className="space-y-4">
        <div className="p-3 rounded-xl bg-[#5b21b6]/8 border border-[#5b21b6]/15 text-sm text-[#5b21b6]">
          La IA extrajo <strong>{items.length} anfitrión(es)</strong> con <strong>{totalRefs} referido(s)</strong>. Revisa y edita lo que necesites antes de guardar.
        </div>

        <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
          {items.map((anf,ai)=>(
            <div key={anf.id} className="border-2 border-[#e8edf3] rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-wider"><Ico e="🏠" className="mr-1.5" />Anfitrión {ai+1}</span>
                <button onClick={()=>delAnf(ai)} className="text-xs text-red-500 font-bold"><Ico e="🗑" className="mr-1.5" />Quitar</button>
              </div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div className="col-span-2"><input className={inp} placeholder="Nombre del anfitrión" value={anf.anfitrion} onChange={e=>setAnf(ai,{anfitrion:e.target.value})} /></div>
                <input className={inp} placeholder="Regalo prometido" value={anf.regalo} onChange={e=>setAnf(ai,{regalo:e.target.value})} />
                <input className={inp} placeholder="Teléfono" value={anf.anfitrion_telefono} onChange={e=>setAnf(ai,{anfitrion_telefono:e.target.value})} />
                <input className={inp} placeholder="Ciudad" value={anf.anfitrion_ciudad} onChange={e=>setAnf(ai,{anfitrion_ciudad:e.target.value})} />
                <input className={inp} placeholder="Cuenta" value={anf.anfitrion_cuenta} onChange={e=>setAnf(ai,{anfitrion_cuenta:e.target.value})} />
              </div>

              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 mt-3"><Ico e="👥" className="mr-1.5" />Referidos</div>
              <div className="space-y-2">
                {anf.referidos.map((r,ri)=>(
                  <div key={ri} className="bg-[#f4f6f9] rounded-lg p-2 relative">
                    <div className="grid grid-cols-2 gap-1.5">
                      <input className={inp} placeholder="Nombre" value={r.nombre} onChange={e=>setRef(ai,ri,{nombre:e.target.value})} />
                      <input className={inp} placeholder="Parentesco" value={r.parentesco} onChange={e=>setRef(ai,ri,{parentesco:e.target.value})} />
                      <input className={inp} placeholder="Teléfono" value={r.telefono} onChange={e=>setRef(ai,ri,{telefono:e.target.value})} />
                      <input className={inp} placeholder="Producto interés" value={r.producto} onChange={e=>setRef(ai,ri,{producto:e.target.value})} />
                      <div className="col-span-2"><input className={inp} placeholder="Dirección" value={r.direccion} onChange={e=>setRef(ai,ri,{direccion:e.target.value})} /></div>
                    </div>
                    <button onClick={()=>delRef(ai,ri)} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center"><Ico e="✕" /></button>
                  </div>
                ))}
                <button onClick={()=>addRef(ai)} className="text-xs text-[#7c3aed] font-bold hover:underline">+ Agregar referido a este anfitrión</button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <button onClick={()=>onSave(items)} className="w-full px-4 py-3 rounded-xl text-sm font-bold text-white" style={{background:RP.navy}}>
            <Ico e="✅" className="mr-1.5" />Guardar {items.length} anfitrión(es) · {totalRefs} referido(s)
          </button>
          <button onClick={onClose} className="w-full px-4 py-2.5 rounded-xl text-sm font-bold text-slate-500 bg-[#f4f6f9]">
            Cancelar — no guardar nada
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── CUMPLEAÑOS ───────────────────────────────────────────────
// Mensaje de felicitación: editable en Configuración → 🎂 Mensaje de cumpleaños.
// {nombre} se reemplaza por el primer nombre del cumpleañero.
const CUMPLE_MSG_DEFAULT = `¡Feliz cumpleaños, {nombre}! 🎉🎂\n\nDe parte de todo el equipo de Royal Prestige queremos desearte un día maravilloso, lleno de alegría, salud y muchas bendiciones. 🥳✨\n\nY porque hoy es tu día, queremos consentirte con un obsequio totalmente gratis por tu cumpleaños 🎁\n\nPara reclamarlo, solo responde este mensaje con:\n“Me lo merezco” 😍🎉`;
let CUMPLE_MSG_TPL = CUMPLE_MSG_DEFAULT;
function setCumpleMsgTpl(t){ CUMPLE_MSG_TPL = (t && String(t).trim()) ? String(t) : CUMPLE_MSG_DEFAULT; }
const cumpleMsg = (nombre) => {
  const primer = (nombre||"").split(" ")[0] || nombre || "";
  return encodeURIComponent(CUMPLE_MSG_TPL.split("{nombre}").join(primer));
};
const waLinkMsg = (n, nombre) => waLink(n) + "?text=" + cumpleMsg(nombre);
const smsLinkMsg = (n, nombre) => "sms:" + soloDigitos(n) + "&body=" + cumpleMsg(nombre);
const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

function CumpleSection({ cumpleanos, setCumple, allData, agente, notify, puedeImportar }) {
  const [showForm,setShowForm]=useState(false);
  const [showAI,setShowAI]=useState(false);
  const [editItem,setEditItem]=useState(null);
  const hoy=new Date(); const mesActual=hoy.getMonth(); const diaActual=hoy.getDate();
  const [mesVer,setMesVer]=useState(mesActual);

  // Toda la base de datos junta (agregados + prospección + distribución + referidos)
  const baseCompleta=[
    ...(allData?.agregados||[]),
    ...(allData?.prospectos||[]),
    ...(allData?.distribucion||[]),
    ...((allData?.referidos||[]).flatMap(anf=>(anf.referidos||[]))),
  ].filter(c=>!c.eliminado);

  // Normalizar para comparar (sin acentos, minúsculas, sin espacios extra)
  const normNombre=(s)=>(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ").trim();
  const normCuenta=(s)=>(s||"").toString().toLowerCase().replace(/[^a-z0-9]/g,"").trim();

  // Buscar teléfono en toda la base por nombre O número de cuenta
  const buscarTelefono=(nombre,cuenta)=>{
    const nN=normNombre(nombre), nC=normCuenta(cuenta);
    // 1) Match por cuenta (más confiable)
    if(nC){
      const porCuenta=baseCompleta.find(c=>c.cuenta && normCuenta(c.cuenta)===nC && c.telefono);
      if(porCuenta) return porCuenta.telefono;
    }
    // 2) Match por nombre
    if(nN){
      const porNombre=baseCompleta.find(c=>normNombre(c.nombre)===nN && c.telefono);
      if(porNombre) return porNombre.telefono;
    }
    return "";
  };

  // Cumpleaños de la base (distribución + agregados con fecha_cumple)
  const desdeBase=baseCompleta
    .filter(c=>c.fecha_cumple)
    .map(c=>({ id:"base::"+c.id, nombre:c.nombre, telefono:c.telefono, cuenta:c.cuenta, fecha_cumple:c.fecha_cumple, origen:"base" }));

  // Para los manuales: si NO tiene teléfono, buscarlo en toda la base por nombre/cuenta
  const manuales=(cumpleanos||[]).map(c=>{
    let tel=c.telefono;
    if(!tel || !tel.replace(/[^0-9]/g,"")){
      tel=buscarTelefono(c.nombre, c.cuenta) || tel;
    }
    return {...c, telefono:tel, origen:"manual"};
  });
  // Evitar duplicados por teléfono
  const telsManuales=new Set(manuales.map(c=>(c.telefono||"").replace(/[^0-9]/g,"")).filter(Boolean));
  const todos=[...manuales, ...desdeBase.filter(c=>{
    const t=(c.telefono||"").replace(/[^0-9]/g,"");
    return !t || !telsManuales.has(t);
  })];

  // Parsear fecha_cumple "MM-DD" o "YYYY-MM-DD" o "DD/MM"
  const parseMesDia=(fc)=>{
    if(!fc) return null;
    let m,d;
    if(/^\d{4}-\d{2}-\d{2}$/.test(fc)){ const p=fc.split("-"); m=+p[1]-1; d=+p[2]; }
    else if(/^\d{1,2}-\d{1,2}$/.test(fc)){ const p=fc.split("-"); m=+p[0]-1; d=+p[1]; }
    else if(/^\d{1,2}\/\d{1,2}$/.test(fc)){ const p=fc.split("/"); m=+p[0]-1; d=+p[1]; }
    else return null;
    return {mes:m, dia:d};
  };

  // Agrupar por mes
  const conMesDia=todos.map(c=>({...c, md:parseMesDia(c.fecha_cumple)})).filter(c=>c.md);
  const cumpleHoy=conMesDia.filter(c=>c.md.mes===mesActual && c.md.dia===diaActual);
  // Conteo por mes (para el selector)
  const conteoPorMes={}; conMesDia.forEach(c=>{ conteoPorMes[c.md.mes]=(conteoPorMes[c.md.mes]||0)+1; });

  const fmtFecha=(md)=> `${md.dia} de ${MESES[md.mes]}`;

  const eliminar=(c)=>{
    if(c.origen==="base"){ alert("Este cumpleaños viene de tu base de datos (Agregados/Distribución/etc). Edítalo o quítale la fecha desde su sección original."); return; }
    if(!confirm("¿Eliminar este cumpleaños?")) return;
    setCumple(p=>p.filter(x=>x.id!==c.id));
  };

  const guardar=(item)=>{
    if(editItem && editItem.id){
      // Editar un manual existente
      setCumple(p=>p.map(x=>x.id===editItem.id?{...item,id:editItem.id}:x));
    } else {
      // Nuevo manual (o edición de uno que venía de "base" → se guarda como manual)
      setCumple(p=>[{...item,id:genId()},...p]);
    }
    setShowForm(false); setEditItem(null);
  };

  // Editar un cumpleañero (manual edita directo; base crea copia manual editable)
  const editar=(c)=>{
    setEditItem({
      id: c.origen==="manual" ? c.id : null,  // si es base, se guarda como nuevo manual
      nombre: c.nombre||"",
      telefono: c.telefono||"",
      cuenta: c.cuenta||"",
      fecha_cumple: c.fecha_cumple||"",
    });
    setShowForm(true);
  };

  const Card=({c})=>(
    <div className="flex items-center justify-between gap-2 py-3 border-b border-[#f4f6f9] last:border-0">
      <div className="min-w-0 flex-1">
        <div className="font-bold text-sm text-[#1f2d3d] truncate">{c.nombre}{c.origen==="base"&&<span className="ml-1.5 text-[9px] bg-[#5b21b6]/10 text-[#5b21b6] px-1 py-0.5 rounded font-bold">BASE</span>}</div>
        <div className="text-xs text-slate-400">{c.md?fmtFecha(c.md):c.fecha_cumple} · {c.telefono||"⚠️ sin teléfono"}</div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {c.telefono && <a href={waLinkMsg(c.telefono,c.nombre)} target="_blank" rel="noreferrer" className="text-white text-[11px] font-bold px-2.5 py-1.5 rounded-lg" style={{background:"#25D366"}}><Ico e="💬" className="mr-1.5" />WA</a>}
        {c.telefono && <a href={smsLinkMsg(c.telefono,c.nombre)} className="text-[#5b21b6] text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-[#e5def4]">SMS</a>}
        {c.telefono && <a href={telLink(c.telefono)} className="text-[11px] px-2 py-1.5 rounded-lg border border-[#e5def4]"><Ico e="📞" /></a>}
        <button onClick={()=>editar(c)} className="text-[#7c3aed] text-[11px] px-2 py-1.5 rounded-lg border border-[#e5def4]"><Ico e="✏" /></button>
        <button onClick={()=>eliminar(c)} className="text-red-400 text-[11px] px-2 py-1.5 rounded-lg border border-red-100"><Ico e="🗑" /></button>
      </div>
    </div>
  );

  // Mes seleccionado para ver (por defecto el actual)
  const cumpleDelMes=conMesDia.filter(c=>c.md.mes===mesVer).sort((a,b)=>a.md.dia-b.md.dia);
  const sinTelefono=cumpleDelMes.filter(c=>!c.telefono).length;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-black text-[#5b21b6]" style={{fontFamily:SERIF}}>Cumpleaños</h2>
        <div className="flex gap-2 mt-3">
          {puedeImportar && <button onClick={()=>setShowAI(true)} className="px-4 py-2.5 rounded-lg text-sm font-bold text-white flex items-center gap-2" style={{background:RP.navy}}><Ico e="📤" className="mr-1.5" />Importar reporte</button>}
          <button onClick={()=>{setEditItem(null);setShowForm(true);}} className="px-4 py-2.5 rounded-lg text-sm font-bold border-2 border-[#5b21b6] text-[#5b21b6]">+ Agregar</button>
        </div>
        <p className="text-xs text-slate-400 mt-3 leading-relaxed">Sube cada mes el reporte de cumpleaños (foto o PDF) y la app sincroniza el teléfono con tu base de datos (Agregados, Distribución, etc.) por nombre o cuenta. Te avisa <strong>2 días antes</strong> y <strong>el día</strong> para felicitar. Los cumpleaños se guardan mes a mes.</p>
      </div>

      {/* HOY CUMPLEN — siempre visible arriba */}
      {cumpleHoy.length>0 && (
        <div className="bg-white rounded-2xl p-4 shadow-sm border-2 border-[#16a34a]">
          <div className="text-sm font-black text-[#16a34a] uppercase tracking-wide mb-1"><Ico e="🎉" className="mr-1.5" />¡Hoy cumplen! ({cumpleHoy.length})</div>
          {cumpleHoy.map(c=><Card key={c.id} c={c} />)}
        </div>
      )}

      {/* SELECTOR DE MES */}
      <div className="bg-white rounded-2xl p-3 shadow-sm border border-[#e8edf3]">
        <div className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-2 px-1">Ver cumpleaños por mes</div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {MESES.map((m,i)=>(
            <button key={i} onClick={()=>setMesVer(i)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition relative ${mesVer===i?"text-white":"bg-[#f4f6f9] text-slate-500"}`}
              style={mesVer===i?{background:RP.navy}:{}}>
              {m.slice(0,3)}{conteoPorMes[i]?<span className={`ml-1 ${mesVer===i?"text-white/70":"text-[#7c3aed]"}`}>({conteoPorMes[i]})</span>:""}
            </button>
          ))}
        </div>
      </div>

      {/* CUMPLEAÑOS DEL MES SELECCIONADO */}
      {cumpleDelMes.length>0 ? (
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-[#e8edf3]">
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs font-black text-slate-500 uppercase tracking-wide">{MESES[mesVer]} ({cumpleDelMes.length})</div>
            {sinTelefono>0 && <div className="text-[10px] text-amber-500 font-bold"><Ico e="⚠" className="mr-1.5" />{sinTelefono} sin teléfono</div>}
          </div>
          {cumpleDelMes.map(c=><Card key={c.id} c={c} />)}
        </div>
      ) : (
        <div className="bg-white rounded-2xl p-8 text-center shadow-sm border border-[#e8edf3]">
          <div className="mb-2 flex justify-center"><Ico e="🎂" size={36} strokeWidth={1.25} className="opacity-40" /></div>
          <div className="text-sm text-slate-400">No hay cumpleaños en {MESES[mesVer]}. Importa el reporte del mes o agrégalos manualmente.</div>
        </div>
      )}

      {showForm && <CumpleForm item={editItem} onSave={guardar} onClose={()=>{setShowForm(false);setEditItem(null);}} />}
      {showAI && <Modal title="📤 Importar cumpleaños con IA" onClose={()=>setShowAI(false)}><CumpleAIImport onImported={(lista)=>{setCumple(p=>[...lista.map(x=>({...x,id:genId()})),...p]);setShowAI(false);}} onClose={()=>setShowAI(false)} /></Modal>}
    </div>
  );
}

// Formulario manual de cumpleaños
function CumpleForm({ item, onSave, onClose }) {
  const [nombre,setNombre]=useState(item?.nombre||"");
  const [telefono,setTelefono]=useState(item?.telefono||"");
  const [fecha,setFecha]=useState(item?.fecha_cumple||"");
  const [cuenta,setCuenta]=useState(item?.cuenta||"");
  const guardar=()=>{
    if(!nombre.trim()){alert("Escribe el nombre");return;}
    onSave({nombre:nombre.trim(), telefono:telefono.trim(), fecha_cumple:fecha.trim(), cuenta:cuenta.trim()});
  };
  return (
    <Modal title={item?<><Ico e="✏" className="mr-1" />Editar cumpleaños</>:<><Ico e="🎂" className="mr-1" />Agregar cumpleaños</>} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Nombre"><input value={nombre} onChange={e=>setNombre(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" placeholder="Nombre completo" /></Field>
        <Field label="Teléfono (opcional — se busca en tu base)"><input value={telefono} onChange={e=>setTelefono(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" placeholder="Déjalo vacío para sincronizar" /></Field>
        <Field label="N° de cuenta (opcional — ayuda al match)"><input value={cuenta} onChange={e=>setCuenta(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" placeholder="RP-0000" /></Field>
        <Field label="Fecha de cumpleaños"><input type="date" value={/^\d{4}-\d{2}-\d{2}$/.test(fecha)?fecha:""} onChange={e=>setFecha(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" /></Field>
        <button onClick={guardar} className="w-full px-4 py-3 rounded-xl text-sm font-bold text-white" style={{background:"#16a34a"}}><Ico e="💾" className="mr-1.5" />Guardar</button>
      </div>
    </Modal>
  );
}

// Importar cumpleaños con IA (foto o PDF del reporte mensual)
function CumpleAIImport({ onImported, onClose }) {
  const [file,setFile]=useState(null);const [loading,setLoading]=useState(false);
  const [preview,setPreview]=useState(null);const [error,setError]=useState("");const fileRef=useRef();
  const [modelo,setModelo]=useState("haiku");
  const MODELOS={ haiku:{id:"claude-haiku-4-5-20251001",ico:"⚡", label:"Rápido",badge:"HAIKU"}, sonnet:{id:"claude-sonnet-4-5",ico:"🧠", label:"Preciso",badge:"SONNET"} };
  const handleFile=e=>{const f=e.target.files[0];if(!f)return;setFile(f);setPreview(null);setError("");};
  const extract=async()=>{
    if(!file){setError("Primero selecciona un archivo.");return;}
    setLoading(true);setError("");
    try{
      const b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.onerror=()=>rej(new Error("No se pudo leer el archivo"));r.readAsDataURL(file);});
      const isPdf=file.type==="application/pdf" || /\.pdf$/i.test(file.name||"");
      let mediaType=(file.type||"").toLowerCase();
      if(!isPdf){
        const name=(file.name||"").toLowerCase();
        if(mediaType==="image/jpg") mediaType="image/jpeg";
        if(!["image/jpeg","image/png","image/gif","image/webp"].includes(mediaType)){
          if(/\.(jpe?g)$/i.test(name)) mediaType="image/jpeg";
          else if(/\.png$/i.test(name)) mediaType="image/png";
          else if(/\.(heic|heif)$/i.test(name)){ throw new Error("El formato HEIC del iPhone no es compatible. Toma una captura de pantalla y súbela."); }
          else mediaType="image/jpeg";
        }
      }
      const sizeMB=(b64.length*0.75)/(1024*1024);
      if(sizeMB>4.5) throw new Error("La imagen es muy grande. Toma una captura de pantalla o redúcela.");
      const block=isPdf?{type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}}:{type:"image",source:{type:"base64",media_type:mediaType,data:b64}};
      const sys=`Extrae los cumpleaños del documento. Responde SOLO JSON sin backticks. Formato: {"cumpleanos":[{"nombre":"","telefono":"","cuenta":"","fecha_cumple":"MM-DD"}]}. La fecha_cumple SIEMPRE en formato MM-DD (mes-día), por ejemplo "06-25" para 25 de junio. Si hay año, ignóralo. "cuenta" = número de cliente si aparece. Campo vacío = "". Incluye TODOS los nombres aunque no tengan teléfono.`;
      let resp;
      try{
        resp=await fetch("/api/anthropic",{method:"POST",headers:{ "Content-Type":"application/json" },
          body:JSON.stringify({model:MODELOS[modelo].id,max_tokens:8000,system:sys,messages:[{role:"user",content:[block,{type:"text",text:"Extrae los cumpleaños. Solo JSON."}]}]})});
      }catch{ throw new Error("No se pudo conectar con el servicio de IA. Revisa tu conexión o créditos."); }
      if(!resp.ok){
        let msg="Error "+resp.status;
        try{ const e=await resp.json(); msg=(e.error&&e.error.message)||msg; }catch{}
        if(resp.status===401) msg="API key inválida o sin créditos. Revisa tu cuenta de Anthropic.";
        if(resp.status===400) msg="El archivo no se pudo procesar. Intenta con una captura de pantalla más clara.";
        throw new Error(msg);
      }
      const data=await resp.json();
      const text=(data.content||[]).map(b=>b.text||"").join("");
      let clean=text.replace(/```json|```/g,"").trim();
      const fb=clean.indexOf("{"); const lb=clean.lastIndexOf("}");
      if(fb>=0&&lb>fb) clean=clean.slice(fb,lb+1);
      let parsed;
      try{ parsed=JSON.parse(clean); }catch{ throw new Error("No se pudo leer la respuesta. Intenta con una imagen más nítida."); }
      const lista=parsed.cumpleanos||[];
      if(!lista.length) throw new Error("No se encontraron cumpleaños en el archivo.");
      setPreview(lista);
    }catch(err){ setError("⚠️ "+(err.message||"No se pudo extraer.")); }
    setLoading(false);
  };
  return (
    <div>
      <div className="bg-[#5b21b6]/8 border border-[#5b21b6]/15 rounded-xl p-4 mb-4 text-sm text-[#5b21b6] font-medium"><strong><Ico e="🎂" className="mr-1.5" />Importar cumpleaños:</strong> Sube el reporte mensual (foto o PDF) y la IA agrega a todos.</div>
      <Field label="Tipo de extracción">
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(MODELOS).map(([k,m])=>(
            <button key={k} type="button" onClick={()=>setModelo(k)} className={`px-3 py-2.5 rounded-xl text-xs font-bold border-2 transition ${modelo===k?"text-white":"border-[#e5def4] bg-white text-slate-600"}`} style={modelo===k?{background:k==="haiku"?"#0d9488":"#7c3aed",borderColor:k==="haiku"?"#0d9488":"#7c3aed"}:{}}>{m.label}</button>
          ))}
        </div>
      </Field>
      <Field label="Archivo (PDF, JPG, PNG)">
        <div onClick={()=>fileRef.current.click()} className="border-2 border-dashed border-[#e5def4] rounded-xl p-6 text-center cursor-pointer hover:border-[#7c3aed] hover:bg-[#f4f6f9] transition">
          <div className="text-3xl mb-2">{file?"📄":"📎"}</div><div className="text-sm text-slate-600 font-bold">{file?file.name:"Toca para seleccionar archivo"}</div>
          <input ref={fileRef} type="file" className="hidden" accept=".pdf,image/*" onChange={handleFile} />
        </div>
      </Field>
      {error && <div className="text-red-500 text-sm mb-3 bg-red-50 p-3 rounded-lg">{error}</div>}
      {!preview && <PrimaryBtn onClick={extract} disabled={!file||loading} full>{loading?`⏳ Extrayendo con ${MODELOS[modelo].badge}…`:`🤖 Extraer con ${MODELOS[modelo].label}`}</PrimaryBtn>}
      {preview && (
        <div>
          <div className="text-sm font-bold text-slate-700 mb-2"><Ico e="✅" className="mr-1.5" />{preview.length} cumpleaños — Revisa antes de guardar:</div>
          <div className="space-y-2 max-h-52 overflow-y-auto mb-4">
            {preview.map((c,i)=>(<div key={i} className="bg-[#f4f6f9] rounded-lg p-3 border border-[#e8edf3] text-sm"><div className="font-bold text-slate-800">{c.nombre||"(Sin nombre)"}</div><div className="text-slate-500 text-xs"><Ico e="🎂" className="mr-1.5" />{c.fecha_cumple} · {c.telefono||"sin teléfono"}</div></div>))}
          </div>
          <div className="flex gap-2">
            <button onClick={()=>onImported(preview)} className="px-4 py-2.5 rounded-lg text-sm font-bold text-white" style={{background:RP.blue}}><Ico e="✅" className="mr-1.5" />Guardar {preview.length}</button>
            <button onClick={()=>{setPreview(null);setFile(null);}} className="px-4 py-2.5 rounded-lg text-sm font-bold text-slate-500 border border-[#e5def4]">Reintentar</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── INCENTIVOS ───────────────────────────────────────────────
// Calcula el progreso real de un incentivo según los datos del CRM.
// ─── CÁLCULO DE RACHA (incentivo tipo juego de 4 semanas) ───
// Cuenta citas/demos/ventas por semana (lunes-domingo) del agente, y evalúa
// la racha contra las metas de cada semana definidas al crear el incentivo.
// Lógica: cumplir meta = sigue en racha. Falla 1 semana → usa vida y continúa.
// Falla 2 → racha vuelve a 0. Completa las 4 → gana bono final + reinicia.
function lunesDeLaSemana(fecha){
  const d=new Date(fecha); d.setHours(0,0,0,0);
  const dia=d.getDay(); // 0=domingo..6=sábado
  const diff=(dia===0?-6:1-dia); // mover a lunes
  d.setDate(d.getDate()+diff);
  return d;
}
function calcularRacha(inc, allData){
  // semanas: array de {metaCitas,metaDemos,metaVentas,bono} definidas al crear
  const semanas=inc.semanas||[];
  if(semanas.length===0) return { activa:false };
  const agente=inc.agente;
  const inicio = inc.fechaInicio ? lunesDeLaSemana(inc.fechaInicio+"T00:00:00") : lunesDeLaSemana(new Date().toISOString());

  // Conteo de logros por número de semana (0..N) desde el inicio
  // Citas = appts tipo "cita" agendadas por el agente en esa semana
  // Demos = historial con demo_venta o demo_no_venta
  // Ventas = historial con demo_venta
  const clientes=[
    ...(allData.agregados||[]),
    ...(allData.prospectos||[]),
    ...(allData.distribucion||[]),
    ...((allData.referidos||[]).flatMap(anf=>(anf.referidos||[]))),
  ];
  const logroSemana={}; // idx -> {citas,demos,ventas}
  const acum=(idx,campo)=>{ if(!logroSemana[idx]) logroSemana[idx]={citas:0,demos:0,ventas:0}; logroSemana[idx][campo]++; };
  const idxDe=(fechaISO)=>{
    if(!fechaISO) return -1;
    const f=lunesDeLaSemana(fechaISO);
    const diff=Math.round((f-inicio)/(1000*60*60*24*7));
    return diff;
  };
  // Citas desde appts
  (allData.appts||[]).forEach(a=>{
    const deAgente=!agente || a.agente===agente;
    if(!deAgente) return;
    if(a.tipo==="cita" || a._type==="cita"){
      const idx=idxDe(a.fecha);
      if(idx>=0 && idx<semanas.length) acum(idx,"citas");
    }
  });
  // Demos y ventas desde historial de clientes
  clientes.forEach(c=>{
    (c.historial||[]).forEach(h=>{
      const deAgente=!agente || h.agente===agente;
      if(!deAgente) return;
      const idx=idxDe(h.fecha);
      if(idx<0 || idx>=semanas.length) return;
      if(h.cita_resultado==="demo_venta"||h.cita_resultado==="demo_no_venta"||
         h.cita_resultado==="venta"||h.cita_resultado==="no_venta") acum(idx,"demos");
      if(h.cita_resultado==="demo_venta"||h.cita_resultado==="venta") acum(idx,"ventas");
    });
  });

  // ¿Cuál es la semana actual (índice) respecto a hoy?
  const hoyIdx=idxDe(new Date().toISOString());

  // Evaluar cada semana: ¿cumplió su meta?
  const evalSemana=(idx)=>{
    const s=semanas[idx]; if(!s) return false;
    const l=logroSemana[idx]||{citas:0,demos:0,ventas:0};
    const okC=!s.metaCitas || l.citas>=Number(s.metaCitas);
    const okD=!s.metaDemos || l.demos>=Number(s.metaDemos);
    const okV=!s.metaVentas || l.ventas>=Number(s.metaVentas);
    return okC&&okD&&okV;
  };

  // Recorrer semanas hasta hoy, aplicando lógica de racha + vida.
  // 'nivel' = semanas CONSECUTIVAS cumplidas (no la posición absoluta).
  let nivel=0;          // racha actual (consecutivas)
  let vidaUsada=false;  // si ya gastó la vida en este ciclo
  let completadoCiclo=false;
  const detalleSemanas=[];
  const ultimaSemanaEval=Math.min(hoyIdx, semanas.length-1);
  for(let i=0;i<=ultimaSemanaEval && i<semanas.length;i++){
    const cumplio=evalSemana(i);
    const l=logroSemana[i]||{citas:0,demos:0,ventas:0};
    detalleSemanas.push({idx:i,cumplio,logro:l,meta:semanas[i]});
    if(cumplio){
      nivel++;  // suma una semana a la racha consecutiva
      if(nivel>=semanas.length){ completadoCiclo=true; }
    } else {
      if(!vidaUsada){ vidaUsada=true; nivel++; } // 1er fallo: usa vida, la semana cuenta igual
      else { nivel=0; vidaUsada=false; }         // 2do fallo: pierde racha, reinicia (recupera vida)
    }
  }

  const semanaActual=Math.min(nivel,semanas.length-1);
  const vidaDisponible=!vidaUsada;
  // Sumar ajuste manual del admin/distribuidor a la semana actual
  const aj=inc.ajusteManual||{};
  const logroBase=logroSemana[semanaActual]||{citas:0,demos:0,ventas:0};
  const logroConAjuste={
    citas:  logroBase.citas  + (Number(aj.citas)||0),
    demos:  logroBase.demos  + (Number(aj.demos)||0),
    ventas: logroBase.ventas + (Number(aj.ventas)||0),
  };
  return {
    activa:true,
    semanas, detalleSemanas,
    nivel,
    semanaActual,
    vidaDisponible,
    completadoCiclo,
    logroActual: logroConAjuste,
    totalSemanas: semanas.length,
    bonoFinal: semanas[semanas.length-1]?.bono || "",
  };
}

function calcularProgresoIncentivo(inc, allData) {
  const desde = inc.fechaInicio ? new Date(inc.fechaInicio+"T00:00:00") : null;
  const hasta = inc.fechaFin ? new Date(inc.fechaFin+"T23:59:59") : null;
  const agente = inc.agente;
  const enRango = (fechaISO) => {
    if(!fechaISO) return false;
    const f = new Date(fechaISO);
    if(desde && f<desde) return false;
    if(hasta && f>hasta) return false;
    return true;
  };
  const clientes = [
    ...(allData.agregados||[]),
    ...(allData.prospectos||[]),
    ...(allData.distribucion||[]),
    ...((allData.referidos||[]).flatMap(anf=>(anf.referidos||[]))),
  ];
  let citas=0;
  // Citas AGENDADAS (appts tipo "cita" del agente en el periodo)
  (allData.appts||[]).forEach(a=>{
    const deAgente = !agente || a.agente===agente;
    if(!deAgente || !enRango(a.fecha)) return;
    if(a.tipo==="cita" || a._type==="cita") citas++;
  });
  // Demos / ventas / valor con la función central (citas de agenda + historial),
  // para que coincidan exactamente con Control de actividad y Estadísticas.
  const _vd = contarVentasDemos({ appts: allData.appts||[], clientes, enP: enRango, agente });
  let demos = _vd.demos, ventas = _vd.ventas, valor = _vd.volumen;
  // Sumar ajuste manual del admin/distribuidor/asistente
  const aj=inc.ajusteManual||{};
  citas  += Number(aj.citas)||0;
  demos  += Number(aj.demos)||0;
  ventas += Number(aj.ventas)||0;
  valor  += Number(aj.valor)||0;
  const metaCitas=Number(inc.metaCitas)||0;
  const metaDemos=Number(inc.metaDemos)||0;
  const metaVentas=Number(inc.metaVentas)||0;
  const metaValor=Number(inc.metaValor)||0;
  const partes=[];
  if(metaCitas>0) partes.push(Math.min(1,citas/metaCitas));
  if(metaDemos>0) partes.push(Math.min(1,demos/metaDemos));
  if(metaVentas>0) partes.push(Math.min(1,ventas/metaVentas));
  if(metaValor>0) partes.push(Math.min(1,valor/metaValor));
  const pct = partes.length? Math.round(partes.reduce((a,b)=>a+b,0)/partes.length*100) : 0;
  let diasRestantes=null;
  if(hasta){
    const hoy=new Date(); hoy.setHours(0,0,0,0);
    diasRestantes=Math.max(0,Math.ceil((hasta-hoy)/(1000*60*60*24)));
  }
  const completado = partes.length>0 && partes.every(p=>p>=1);

  // ── GAMIFICACIÓN: estado de misión, racha, medallas ──
  let estadoMision="activa";
  if(completado) estadoMision="completada";
  else if(diasRestantes===0) estadoMision="vencida";
  else if(pct>0) estadoMision="en_progreso";

  // Racha diaria: días consecutivos (hasta hoy) con al menos 1 actividad del agente
  const diasConActividad=new Set();
  clientes.forEach(c=>{
    (c.historial||[]).forEach(h=>{
      const deAgente = !agente || h.agente===agente;
      if(deAgente && h.fecha && enRango(h.fecha)) diasConActividad.add(new Date(h.fecha).toISOString().slice(0,10));
    });
  });
  let racha=0;
  { const d=new Date(); d.setHours(0,0,0,0);
    for(let i=0;i<60;i++){
      const key=d.toISOString().slice(0,10);
      if(diasConActividad.has(key)) racha++;
      else if(i>0) break; // permite que hoy aún no tenga actividad sin cortar la racha de ayer
      d.setDate(d.getDate()-1);
    }
  }

  // Medallas por hitos de progreso
  const medallas=[];
  if(pct>=25) medallas.push({icon:"🥉",label:"25%"});
  if(pct>=50) medallas.push({icon:"🥈",label:"50%"});
  if(pct>=75) medallas.push({icon:"🥇",label:"75%"});
  if(pct>=100) medallas.push({icon:"🏆",label:"¡Completa!"});
  if(racha>=3) medallas.push({icon:"🔥",label:`Racha ${racha}`});

  // Mensaje motivacional según progreso
  let mensaje="¡Arranca tu misión! 💪";
  if(pct>=100) mensaje="¡Misión cumplida! Eres una leyenda 🎉";
  else if(pct>=75) mensaje="¡Ya casi! Un último empujón 🚀";
  else if(pct>=50) mensaje="¡Vas a mitad de camino! Sigue así 🔥";
  else if(pct>=25) mensaje="¡Buen comienzo! No pares 💪";
  else if(pct>0) mensaje="¡Primeros pasos dados! Acelera ⚡";

  return { citas, demos, ventas, valor, metaCitas, metaDemos, metaVentas, metaValor, pct, diasRestantes, completado, estadoMision, racha, medallas, mensaje };
}

// Barra de progreso de una meta individual
function MetaBar({ label, actual, meta, color }) {
  if(!meta || meta<=0) return null;
  const pct=Math.min(100,Math.round(actual/meta*100));
  return (
    <div className="mb-2">
      <div className="flex justify-between text-[11px] font-bold mb-0.5">
        <span className="text-slate-600">{label}</span>
        <span style={{color}}>{actual} / {meta}{pct>=100?" ✅":""}</span>
      </div>
      <div className="h-2.5 rounded-full bg-[#f1ecfd] overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{width:pct+"%",background:color}} />
      </div>
    </div>
  );
}

// Tarjeta de progreso de incentivo (para el Inicio del agente)
function IncentivoProgreso({ inc, allData, compact }) {
  const p=calcularProgresoIncentivo(inc, allData);
  const ESTADO_MISION={
    activa:      { ico:"🎯", label:"Misión activa",   chip:"#7c3aed" },
    en_progreso: { ico:"⚡", label:"En progreso",     chip:"#b45309" },
    completada:  { ico:"✅", label:"Completada",      chip:"#16a34a" },
    vencida:     { ico:"⏰", label:"Vencida",         chip:"#64748b" },
  };
  const em=ESTADO_MISION[p.estadoMision]||ESTADO_MISION.activa;
  const headerBg = p.completado
    ? "linear-gradient(135deg,#16a34a,#15803d)"
    : p.estadoMision==="vencida"
      ? "linear-gradient(135deg,#64748b,#475569)"
      : `linear-gradient(135deg,${RP.navy},${RP.blue})`;
  return (
    <div className={`rounded-2xl border-2 overflow-hidden ${p.completado?"border-[#16a34a]":p.estadoMision==="vencida"?"border-slate-300":"border-[#e8b800]"}`}>
      {/* Cabecera de misión */}
      <div className="px-4 py-3" style={{background:headerBg}}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-black text-white/90 bg-white/20 px-2 py-0.5 rounded-full uppercase tracking-wide">{em.label}</span>
          <div className="flex items-center gap-1.5">
            {p.racha>=2 && <span className="text-[10px] font-black text-white bg-orange-500/80 px-2 py-0.5 rounded-full"><Ico e="🔥" className="mr-1.5" />{p.racha} días</span>}
            {p.diasRestantes!==null && <span className="text-[10px] font-bold text-white/90 bg-white/20 px-2 py-0.5 rounded-full">{p.diasRestantes===0?"Último día":`${p.diasRestantes} días`}</span>}
          </div>
        </div>
        <div className="text-white font-black text-base" style={{fontFamily:SERIF}}><Ico e="🎮" className="mr-1.5" />{inc.nombre||"Misión"}</div>
        {inc.descripcion && <div className="text-white/75 text-[11px] mt-0.5 italic">{inc.descripcion}</div>}
        {inc.premio && <div className="text-white/85 text-xs mt-0.5"><Ico e="🎁" className="mr-1.5" />Recompensa: {inc.premio}</div>}
      </div>

      <div className="p-4 bg-white">
        {p.completado ? (
          <div className="text-center py-3">
            <div className="mb-2 animate-bounce flex justify-center"><Ico e="🎉" size={44} strokeWidth={1.5} className="text-[#C8A24A]" /></div>
            <div className="font-black text-[#16a34a] text-xl" style={{fontFamily:SERIF}}>Congratulations!</div>
            <div className="text-sm font-bold text-slate-700 mt-1">{p.mensaje}</div>
            <div className="text-xs text-slate-500 mt-1">¡Misión cumplida! Habla con tu líder por tu recompensa 🏆</div>
            {p.medallas.length>0 && (
              <div className="flex items-center justify-center gap-1.5 flex-wrap mt-3">
                {p.medallas.map((m,i)=>(<span key={i} className="inline-flex items-center" title={m.label}><Ico e={m.icon} size={16} className="text-[#C8A24A]" /></span>))}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Barra de progreso grande estilo juego */}
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Progreso de misión</span>
              <span className="text-2xl font-black text-[#5b21b6]" style={{fontFamily:SERIF}}>{p.pct}%</span>
            </div>
            <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden mb-2">
              <div className="h-full rounded-full transition-all duration-700" style={{width:`${p.pct}%`,background:p.pct>=75?"linear-gradient(90deg,#16a34a,#22c55e)":p.pct>=50?"linear-gradient(90deg,#93C5FD,#60A5FA)":"linear-gradient(90deg,#b45309,#f59e0b)"}} />
            </div>
            {/* Mensaje motivacional */}
            <div className="text-center text-xs font-bold text-[#5b21b6] bg-[#f1ecfd] rounded-lg py-1.5 mb-3">{p.mensaje}</div>

            {/* Medallas ganadas */}
            {p.medallas.length>0 && (
              <div className="flex items-center gap-1.5 flex-wrap mb-3 justify-center">
                {p.medallas.map((m,i)=>(
                  <span key={i} className="inline-flex items-center gap-1 text-[10px] font-bold bg-amber-50 text-amber-700 px-2 py-1 rounded-full border border-amber-200">
                    <Ico e={m.icon} size={14} />{m.label}
                  </span>
                ))}
              </div>
            )}

            {/* Metas */}
            <MetaBar label="📅 Citas" actual={p.citas} meta={p.metaCitas} color="#16a34a" />
            <MetaBar label="🎬 Demostraciones" actual={p.demos} meta={p.metaDemos} color="#7c3aed" />
            <MetaBar label="💰 Ventas" actual={p.ventas} meta={p.metaVentas} color="#047857" />
            <MetaBar label="💵 Valor vendido" actual={p.valor} meta={p.metaValor} color="#b45309" />
          </>
        )}
      </div>
    </div>
  );
}

// Pestaña INCENTIVO (crear y administrar — solo admin/distribuidor)
// ─── RACHA: visual tipo juego (4 semanas con vida) ───
function RachaProgreso({ inc, allData }) {
  const r=calcularRacha(inc, allData);
  if(!r.activa) return null;
  const niveles=r.semanas.length;
  return (
    <div className="rounded-2xl border-2 border-[#e8b800] overflow-hidden">
      {/* Cabecera */}
      <div className="px-4 py-3" style={{background:r.completadoCiclo?"linear-gradient(135deg,#16a34a,#15803d)":`linear-gradient(135deg,${RP.navy},${RP.blue})`}}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-black text-white/90 bg-white/20 px-2 py-0.5 rounded-full uppercase tracking-wide"><Ico e="🔥" className="mr-1.5" />Racha · {inc.agente||"Equipo"}</span>
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${r.vidaDisponible?"bg-white/25 text-white":"bg-black/20 text-white/50 line-through"}`}><Ico e="🛡" className="mr-1.5" />{r.vidaDisponible?"1 vida":"sin vida"}</span>
            <span className="text-[10px] font-black text-white bg-white/20 px-2 py-0.5 rounded-full">Semana {Math.min(r.nivel+1,niveles)}/{niveles}</span>
          </div>
        </div>
        <div className="text-white font-black text-base" style={{fontFamily:SERIF}}><Ico e="🎮" className="mr-1.5" />{inc.nombre||"Reto en racha"}</div>
        {inc.descripcion && <div className="text-white/75 text-[11px] mt-0.5 italic">{inc.descripcion}</div>}
      </div>

      <div className="p-4 bg-white">
        {r.completadoCiclo ? (
          <div className="text-center py-3">
            <div className="mb-2 animate-bounce flex justify-center"><Ico e="🎉" size={44} strokeWidth={1.5} className="text-[#C8A24A]" /></div>
            <div className="font-black text-[#16a34a] text-xl" style={{fontFamily:SERIF}}>Congratulations!</div>
            <div className="text-sm font-bold text-slate-700 mt-1">¡Completaste las {niveles} semanas en racha!</div>
            {r.bonoFinal && <div className="text-xs text-[#b45309] bg-amber-50 rounded-lg px-3 py-1.5 mt-2 inline-block font-bold"><Ico e="🎁" className="mr-1.5" />{r.bonoFinal}</div>}
            <div className="text-[11px] text-slate-400 mt-2">La racha se reinicia para un nuevo ciclo 🔄</div>
          </div>
        ) : (
          <>
            {/* Niveles tipo videojuego */}
            <div className="flex items-center justify-between gap-1 mb-3">
              {r.semanas.map((s,i)=>{
                const det=r.detalleSemanas.find(d=>d.idx===i);
                const cumplida=det?.cumplio;
                const esActual=i===r.semanaActual;
                const futura=i>r.semanaActual;
                return (
                  <div key={i} className="flex-1 flex flex-col items-center">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg font-black border-2 ${cumplida?"bg-[#16a34a] border-[#16a34a] text-white":esActual?"bg-[#7c3aed]/10 border-[#7c3aed] text-[#7c3aed]":futura?"bg-slate-50 border-slate-200 text-slate-300":"bg-red-50 border-red-300 text-red-400"}`}>
                      {cumplida?"✓":esActual?(i+1):futura?(i+1):"✕"}
                    </div>
                    <div className="text-[9px] font-bold text-slate-400 mt-1">Sem {i+1}</div>
                    {s.bono && <div className="text-[8px] text-[#b45309] font-bold text-center leading-tight">{s.bono}</div>}
                  </div>
                );
              })}
            </div>

            {/* Meta de la semana actual */}
            {(()=>{
              const s=r.semanas[r.semanaActual]||{};
              const l=r.logroActual;
              return (
                <div className="bg-[#f9f5ff] rounded-xl p-3 border border-[#7c3aed]/15">
                  <div className="text-[11px] font-black text-[#7c3aed] uppercase tracking-wider mb-2"><Ico e="🎯" className="mr-1.5" />Meta de la semana {r.semanaActual+1}</div>
                  {Number(s.metaCitas)>0 && <MetaBar label="📅 Citas" actual={l.citas} meta={Number(s.metaCitas)} color="#16a34a" />}
                  {Number(s.metaDemos)>0 && <MetaBar label="🎬 Demostraciones" actual={l.demos} meta={Number(s.metaDemos)} color="#7c3aed" />}
                  {Number(s.metaVentas)>0 && <MetaBar label="💰 Ventas" actual={l.ventas} meta={Number(s.metaVentas)} color="#047857" />}
                  {s.bono && <div className="text-xs text-[#b45309] bg-amber-50 rounded-lg px-2 py-1 mt-2 inline-block font-bold"><Ico e="🎁" className="mr-1.5" />Premio de esta semana: {s.bono}</div>}
                </div>
              );
            })()}

            <div className="text-center text-[11px] font-bold text-[#7c3aed] bg-[#f9f5ff] rounded-lg py-1.5 mt-2">
              {r.vidaDisponible ? <><Ico e="🛡" className="mr-1" />Si fallas una semana, usas tu vida y sigues en racha</> : <><Ico e="⚠" className="mr-1" />Ya usaste tu vida — si fallas otra semana, la racha vuelve a 0</>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}


// ── HUB DE INCENTIVOS: Telemarketing (clásico) + Cobranza + Reclutamiento ──
function MetaBarInc({ pct }){
  return (
    <div className="h-2.5 rounded-full bg-[#eef1f5] overflow-hidden">
      <div className="h-full rounded-full transition-all" style={{width:`${Math.min(100,pct)}%`, background: pct>=100?"#059669":"#7c3aed"}} />
    </div>
  );
}
function IncentivosCobranzaPanel({ metas, setMetas, cobranza }){
  const mesKey = new Date().toISOString().slice(0,7);
  const [form,setForm]=useState(null); // null | {id?,titulo,metaMonto,bono}
  const cobradoMes = (()=>{
    let t=0;
    Object.values((cobranza||{}).clientesData||{}).forEach(c=>(c.historial||[]).forEach(h=>{
      if(h.tipo==="pago" && String(h.fecha||"").startsWith(mesKey)) t += +h.monto||0;
    }));
    return +t.toFixed(2);
  })();
  const lista=(metas||[]).filter(m=>m.mes===mesKey);
  const guardar=()=>{
    if(!form.titulo.trim() || !(+form.metaMonto>0)){ alert("Ponle título y monto meta."); return; }
    if(form.id) setMetas(p=>p.map(x=>x.id===form.id?{...x,...form,metaMonto:+form.metaMonto}:x));
    else setMetas(p=>[...(p||[]),{id:genId(),titulo:form.titulo,metaMonto:+form.metaMonto,bono:form.bono||"",mes:mesKey,creado:new Date().toISOString()}]);
    setForm(null);
  };
  return (
    <div className="space-y-3">
      <div className="rounded-2xl p-4 text-white" style={{background:"linear-gradient(135deg,#065f46,#059669)"}}>
        <div className="text-[11px] opacity-80 uppercase font-black tracking-wider"><Ico e="💵" className="mr-1.5" />Cobrado este mes (automático)</div>
        <div className="text-3xl font-black mt-1" style={{fontFamily:SERIF}}>${cobradoMes.toLocaleString("en-US",{minimumFractionDigits:2})}</div>
        <div className="text-[11px] opacity-75 mt-0.5">Se actualiza solo con cada pago registrado en Cobranza</div>
      </div>
      <button onClick={()=>setForm({titulo:"",metaMonto:"",bono:""})} className="w-full py-2.5 rounded-xl text-sm font-bold text-white" style={{background:RP.navy}}>+ Nueva meta de cobranza</button>
      {lista.length===0 && <div className="text-center py-8 text-slate-400 text-sm">Sin metas este mes. Crea la primera 💪</div>}
      {lista.map(m=>{
        const pct = m.metaMonto>0 ? Math.round(cobradoMes/m.metaMonto*100) : 0;
        return (
          <div key={m.id} className="bg-white rounded-2xl border border-[#e8edf3] p-3.5 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-bold text-sm text-[#1f2d3d]" style={{fontFamily:SERIF}}>{pct>=100?<><Ico e="🏆" className="mr-1" /></>:""}{m.titulo}</div>
                <div className="text-xs text-slate-500 mt-0.5">Meta: ${(+m.metaMonto).toLocaleString("en-US")} {m.bono?` · 🎁 ${m.bono}`:""}</div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={()=>setForm({id:m.id,titulo:m.titulo,metaMonto:m.metaMonto,bono:m.bono||""})} className="w-7 h-7 rounded-lg bg-[#f4f6f9] text-xs"><Ico e="✏" /></button>
                <button onClick={()=>{ if(confirm("¿Eliminar esta meta?")) setMetas(p=>p.filter(x=>x.id!==m.id)); }} className="w-7 h-7 rounded-lg bg-red-50 text-xs"><Ico e="🗑" /></button>
              </div>
            </div>
            <div className="mt-2"><MetaBarInc pct={pct} /></div>
            <div className="text-[11px] font-bold mt-1" style={{color:pct>=100?"#059669":"#7c3aed"}}>
              {pct>=100 ? `✅ ¡Meta lograda! (${pct}%)` : `${pct}% · faltan $${Math.max(0,m.metaMonto-cobradoMes).toLocaleString("en-US",{maximumFractionDigits:0})}`}
            </div>
          </div>
        );
      })}
      {form && (
        <Modal title={form.id?<><Ico e="✏" className="mr-1" />Editar meta</>:<><Ico e="💵" className="mr-1" />Nueva meta de cobranza</>} onClose={()=>setForm(null)}>
          <Field label="Título" required><input className={inpLight} value={form.titulo} onChange={e=>setForm(p=>({...p,titulo:e.target.value}))} placeholder="ej. Recuperar cartera de julio" /></Field>
          <Field label="Meta a cobrar en el mes ($)" required><input type="number" className={inpLight} value={form.metaMonto} onChange={e=>setForm(p=>({...p,metaMonto:e.target.value}))} placeholder="5000" /></Field>
          <Field label="Bono / premio al lograrla"><input className={inpLight} value={form.bono} onChange={e=>setForm(p=>({...p,bono:e.target.value}))} placeholder="ej. $200 extra" /></Field>
          <button onClick={guardar} className="w-full py-3 rounded-xl text-sm font-bold text-white mt-1" style={{background:RP.navy}}><Ico e="✅" className="mr-1.5" />Guardar meta</button>
        </Modal>
      )}
    </div>
  );
}
function IncentivosReclutPanel({ metas, setMetas, socios, reclutamiento }){
  const [form,setForm]=useState(null);
  const DIAS={semanal:7,quincenal:15,mensual:30};
  const hoyMs=Date.now();
  const progresoDe=(m)=>{
    const ini=new Date(m.inicio||m.creado||hoyLocal());
    const fin=new Date(ini.getTime()+ (DIAS[m.periodo]||30)*86400000);
    const dentro=(f)=>{ const d=new Date(f); return !isNaN(d)&&d>=ini&&d<=fin; };
    if(m.tipo==="entrevistas"){
      return (reclutamiento||[]).filter(r=>r.entrevistado && dentro(r.entrevista_fecha||r.creado||m.inicio)).length;
    }
    return (socios||[]).filter(x=>dentro(x.fechaInicio||x.creado)).length;
  };
  const guardar=()=>{
    if(!form.titulo.trim() || !(+form.meta>0)){ alert("Ponle título y número meta."); return; }
    if(form.id) setMetas(p=>p.map(x=>x.id===form.id?{...x,...form,meta:+form.meta}:x));
    else setMetas(p=>[...(p||[]),{id:genId(),titulo:form.titulo,tipo:form.tipo,meta:+form.meta,bono:form.bono||"",periodo:form.periodo,inicio:form.inicio,creado:new Date().toISOString()}]);
    setForm(null);
  };
  const activas=(metas||[]).filter(m=>{
    const ini=new Date(m.inicio||m.creado); const fin=new Date(ini.getTime()+(DIAS[m.periodo]||30)*86400000);
    return hoyMs <= fin.getTime()+86400000*7; // visibles hasta 1 semana después de vencer
  });
  return (
    <div className="space-y-3">
      <button onClick={()=>setForm({titulo:"",tipo:"socios",meta:"",bono:"",periodo:"mensual",inicio:hoyLocal()})} className="w-full py-2.5 rounded-xl text-sm font-bold text-white" style={{background:RP.navy}}>+ Nueva meta de reclutamiento</button>
      {activas.length===0 && <div className="text-center py-8 text-slate-400 text-sm">Sin metas activas. Crea la primera.</div>}
      {activas.map(m=>{
        const prog=progresoDe(m);
        const pct=m.meta>0?Math.round(prog/m.meta*100):0;
        return (
          <div key={m.id} className="bg-white rounded-2xl border border-[#e8edf3] p-3.5 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-bold text-sm text-[#1f2d3d]" style={{fontFamily:SERIF}}>{pct>=100?<><Ico e="🏆" className="mr-1" /></>:""}{m.titulo}</div>
                <div className="text-xs text-slate-500 mt-0.5">{m.tipo==="entrevistas"?<><Ico e="🤝" className="mr-1" />Entrevistas</>:<><Ico e="⭐" className="mr-1" />Socios nuevos</>} · {m.periodo} desde {m.inicio} {m.bono?` · 🎁 ${m.bono}`:""}</div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={()=>setForm({id:m.id,titulo:m.titulo,tipo:m.tipo,meta:m.meta,bono:m.bono||"",periodo:m.periodo,inicio:m.inicio})} className="w-7 h-7 rounded-lg bg-[#f4f6f9] text-xs"><Ico e="✏" /></button>
                <button onClick={()=>{ if(confirm("¿Eliminar esta meta?")) setMetas(p=>p.filter(x=>x.id!==m.id)); }} className="w-7 h-7 rounded-lg bg-red-50 text-xs"><Ico e="🗑" /></button>
              </div>
            </div>
            <div className="mt-2"><MetaBarInc pct={pct} /></div>
            <div className="text-[11px] font-bold mt-1" style={{color:pct>=100?"#059669":"#7c3aed"}}>
              {prog} de {m.meta} {pct>=100?`· ✅ ¡Meta lograda!`:`(${pct}%)`}
            </div>
          </div>
        );
      })}
      {form && (
        <Modal title={form.id?<><Ico e="✏" className="mr-1" />Editar meta</>:<><Ico e="🧲" className="mr-1" />Nueva meta de reclutamiento</>} onClose={()=>setForm(null)}>
          <Field label="Título" required><input className={inpLight} value={form.titulo} onChange={e=>setForm(p=>({...p,titulo:e.target.value}))} placeholder="ej. 3 socios en julio" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Se mide por"><select className={inpLight} value={form.tipo} onChange={e=>setForm(p=>({...p,tipo:e.target.value}))}><option value="socios"><Ico e="⭐" className="mr-1.5" />Socios nuevos</option><option value="entrevistas"><Ico e="🤝" className="mr-1.5" />Entrevistas</option></select></Field>
            <Field label="Número meta" required><input type="number" className={inpLight} value={form.meta} onChange={e=>setForm(p=>({...p,meta:e.target.value}))} placeholder="3" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Periodo"><select className={inpLight} value={form.periodo} onChange={e=>setForm(p=>({...p,periodo:e.target.value}))}><option value="semanal">Semanal</option><option value="quincenal">Quincenal</option><option value="mensual">Mensual</option></select></Field>
            <Field label="Inicia"><input type="date" className={inpLight} value={form.inicio} onChange={e=>setForm(p=>({...p,inicio:e.target.value}))} /></Field>
          </div>
          <Field label="Bono / premio al lograrla"><input className={inpLight} value={form.bono} onChange={e=>setForm(p=>({...p,bono:e.target.value}))} placeholder="ej. cena para dos" /></Field>
          <button onClick={guardar} className="w-full py-3 rounded-xl text-sm font-bold text-white mt-1" style={{background:RP.navy}}><Ico e="✅" className="mr-1.5" />Guardar meta</button>
        </Modal>
      )}
    </div>
  );
}
function IncentivosHub(props){
  const [sub,setSub]=useState("tm");
  const TABS=[["tm","📞","Telemarketing"],["cob","💵","Cobranza"],["rec","🧲","Reclutamiento"]];
  return (
    <div>
      <div className="flex gap-1.5 mb-3">
        {TABS.map(([id,ico,label])=>(
          <button key={id} onClick={()=>setSub(id)}
            className={`flex-1 py-2 rounded-xl text-xs font-black transition ${sub===id?"text-white":"bg-white text-slate-500 border border-[#e8edf3]"}`}
            style={sub===id?{background:RP.navy}:{}}><span className="inline-flex items-center justify-center gap-1.5"><Ico e={ico} size={13} />{label}</span></button>
        ))}
      </div>
      {sub==="tm" && <IncentivoSection incentivos={props.incentivos} setIncentivos={props.setIncentivos} allData={props.allData} agentes={props.agentes} notify={props.notify} rolActivo={props.rolActivo} agenteActivo={props.agenteActivo} cofreConfig={props.cofreConfig} setCofreConfig={props.setCofreConfig} />}
      {sub==="cob" && <IncentivosCobranzaPanel metas={props.incentivosCobranza} setMetas={props.setIncentivosCobranza} cobranza={props.cobranza} />}
      {sub==="rec" && <IncentivosReclutPanel metas={props.incentivosReclut} setMetas={props.setIncentivosReclut} socios={props.socios} reclutamiento={props.reclutamiento} />}
    </div>
  );
}

function IncentivoSection({ incentivos, setIncentivos, allData, agentes, notify, rolActivo="", agenteActivo="", cofreConfig, setCofreConfig }) {
  const [showForm,setShowForm]=useState(false);
  const [editItem,setEditItem]=useState(null);
  const [ajusteId,setAjusteId]=useState(null); // id del incentivo con ajuste abierto
  const [aj,setAj]=useState({citas:0,demos:0,ventas:0,valor:0});
  const [tab,setTab]=useState("normal"); // normal | racha | cofre
  const puedeEditar=puedeCrearIncentivosRol(rolActivo);

  const guardar=(inc)=>{
    if(editItem){
      setIncentivos(p=>p.map(x=>x.id===editItem.id?{...inc,id:editItem.id}:x));
    } else {
      const nuevo={...inc,id:genId(),creado:new Date().toISOString(),estado:"activo"};
      setIncentivos(p=>[nuevo,...p]);
      if(notify && inc.agente){
        notify("incentivo",
          `🏆 Nuevo incentivo para ${inc.agente}`,
          `${inc.nombre}: ${[inc.metaCitas&&`${inc.metaCitas} citas`,inc.metaDemos&&`${inc.metaDemos} demos`,inc.metaVentas&&`${inc.metaVentas} ventas`,inc.metaValor&&`$${inc.metaValor}`].filter(Boolean).join(", ")}. Premio: ${inc.premio||"—"}`,
          "🏆 Incentivo"
        );
      }
    }
    setShowForm(false); setEditItem(null);
  };
  const eliminar=(id)=>{ if(confirm("¿Eliminar este incentivo?")) setIncentivos(p=>p.filter(x=>x.id!==id)); };
  const abrirAjuste=(inc)=>{ setAjusteId(inc.id); setAj(inc.ajusteManual||{citas:0,demos:0,ventas:0,valor:0}); };
  const guardarAjuste=(id)=>{
    setIncentivos(p=>(p||[]).map(i=>i.id===id
      ? {...i, ajusteManual:{citas:Number(aj.citas)||0,demos:Number(aj.demos)||0,ventas:Number(aj.ventas)||0,valor:Number(aj.valor)||0}, ajusteEditadoPor:agenteActivo, ajusteEditado:new Date().toISOString()}
      : i
    ));
    setAjusteId(null);
  };

  const activos=(incentivos||[]).filter(i=>i.estado!=="cancelado");
  const normales=activos.filter(i=>i.tipo!=="racha");
  const rachas=activos.filter(i=>i.tipo==="racha");
  const cofreActivo = !!(cofreConfig && cofreConfig.activo!==false && (cofreConfig.niveles||[]).some(cofreNivelTieneMetas));
  const listaTab = tab==="racha" ? rachas : normales;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-black text-[#5b21b6]" style={{fontFamily:SERIF}}><Ico e="🏆" className="mr-1.5" />Incentivos</h2>
        <p className="text-xs text-slate-400 mt-1">Elige un tipo de meta para configurarla. El progreso de cada agente aparece en su Inicio.</p>
      </div>

      {/* 3 CASILLAS POR TIPO */}
      <div className="grid grid-cols-3 gap-2">
        {[
          {id:"normal", icon:"🎯", label:"Meta normal", badge:String(normales.length), color:"#5b21b6"},
          {id:"racha",  icon:"🔥", label:"Rachas",      badge:String(rachas.length),   color:"#7c3aed"},
          {id:"cofre",  icon:"🎁", label:"Cofres",      badge:(cofreActivo?"Activo":"Apagado"), color:"#c8901f"},
        ].map(c=>(
          <button key={c.id} onClick={()=>setTab(c.id)}
            className={`rounded-2xl p-3 border-2 text-center transition active:scale-95 ${tab===c.id?"shadow-md":"bg-white"}`}
            style={tab===c.id?{borderColor:c.color, background:c.color+"0d"}:{borderColor:"#e8edf3"}}>
            <div className="mb-1 flex justify-center"><Ico e={c.icon} size={22} /></div>
            <div className="text-[11px] font-black leading-tight" style={{color:tab===c.id?c.color:"#475569"}}>{c.label}</div>
            <div className="text-[10px] font-bold text-slate-400 mt-0.5">{c.badge}</div>
          </button>
        ))}
      </div>

      {tab==="cofre" ? (
        <CofreConfigCard cofreConfig={cofreConfig} setCofreConfig={setCofreConfig} rolActivo={rolActivo} />
      ) : (
      <div className="space-y-3">
        {puedeEditar && <button onClick={()=>{setEditItem(null);setShowForm(true);}} className="w-full px-4 py-3 rounded-xl text-sm font-black text-white active:scale-95 transition" style={{background: tab==="racha"?"#7c3aed":RP.navy}}>+ Crear {tab==="racha"?"racha":"meta normal"}</button>}
        {listaTab.length===0 ? (
          <div className="bg-white rounded-2xl p-8 text-center shadow-sm border border-[#e8edf3]">
            <div className="text-4xl mb-2"><Ico e={tab==="racha"?"🔥":"🎯"} size={36} strokeWidth={1.4} className="text-[#C8A24A]" /></div>
            <div className="text-sm text-slate-400">{tab==="racha"?"Aún no hay rachas activas. Crea la primera arriba.":"Aún no hay metas normales activas. Crea la primera arriba."}</div>
          </div>
        ) : (
        <div className="space-y-3">
          {listaTab.map(inc=>{
            const esRacha=inc.tipo==="racha";
            const ajActual=inc.ajusteManual||{};
            const tieneAjuste=ajActual.citas||ajActual.demos||ajActual.ventas||ajActual.valor;
            return (
              <div key={inc.id}>
                {/* Botones de acción */}
                <div className="flex justify-end gap-1.5 mb-1.5">
                  {puedeEditar && (
                    <button onClick={()=>{ if(ajusteId===inc.id){setAjusteId(null);}else{abrirAjuste(inc);} }}
                      className={`text-xs font-bold px-2 py-1 rounded-lg border transition ${ajusteId===inc.id?"text-white border-transparent":"border-[#e5def4] bg-white text-[#b45309]"}`}
                      style={ajusteId===inc.id?{background:"#b45309"}:{}}>
                      <Ico e="✏" className="mr-1.5" />Ajuste manual
                    </button>
                  )}
                  <button onClick={()=>{setEditItem(inc);setShowForm(true);}} className="text-[#7c3aed] text-xs px-2 py-1 rounded-lg border border-[#e5def4] bg-white"><Ico e="✏" className="mr-1.5" />Editar</button>
                  <button onClick={()=>eliminar(inc.id)} className="text-red-400 text-xs px-2 py-1 rounded-lg border border-red-100 bg-white"><Ico e="🗑" /></button>
                </div>

                {/* Panel de ajuste manual */}
                {ajusteId===inc.id && puedeEditar && (
                  <div className="mb-2 border-2 border-[#b45309]/20 rounded-xl p-3 bg-amber-50">
                    <div className="text-[11px] font-black text-[#b45309] uppercase tracking-wider mb-2"><Ico e="✏" className="mr-1.5" />Ajuste manual de avance</div>
                    <div className="text-[10px] text-slate-500 mb-2">Suma o resta al conteo automático. Útil para correcciones o citas no registradas en la app.</div>
                    <div className="grid grid-cols-2 gap-2 mb-2">
                      <div>
                        <div className="text-[9px] font-bold text-slate-400 mb-0.5"><Ico e="📅" className="mr-1.5" />Citas (+/-)</div>
                        <input type="number" value={aj.citas} onChange={e=>setAj(p=>({...p,citas:e.target.value}))}
                          className="w-full border border-amber-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-amber-500 bg-white" placeholder="0" />
                      </div>
                      <div>
                        <div className="text-[9px] font-bold text-slate-400 mb-0.5"><Ico e="🎬" className="mr-1.5" />Demos (+/-)</div>
                        <input type="number" value={aj.demos} onChange={e=>setAj(p=>({...p,demos:e.target.value}))}
                          className="w-full border border-amber-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-amber-500 bg-white" placeholder="0" />
                      </div>
                      <div>
                        <div className="text-[9px] font-bold text-slate-400 mb-0.5"><Ico e="💰" className="mr-1.5" />Ventas (+/-)</div>
                        <input type="number" value={aj.ventas} onChange={e=>setAj(p=>({...p,ventas:e.target.value}))}
                          className="w-full border border-amber-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-amber-500 bg-white" placeholder="0" />
                      </div>
                      {!esRacha && (
                        <div>
                          <div className="text-[9px] font-bold text-slate-400 mb-0.5"><Ico e="💵" className="mr-1.5" />Valor $ (+/-)</div>
                          <input type="number" value={aj.valor} onChange={e=>setAj(p=>({...p,valor:e.target.value}))}
                            className="w-full border border-amber-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-amber-500 bg-white" placeholder="0" />
                        </div>
                      )}
                    </div>
                    {tieneAjuste && <div className="text-[10px] text-amber-700 bg-amber-100 rounded-lg px-2 py-1 mb-2">Ajuste actual: +{ajActual.citas||0} citas · +{ajActual.demos||0} demos · +{ajActual.ventas||0} ventas{!esRacha?` · +$${ajActual.valor||0}`:""}{inc.ajusteEditadoPor?` (por ${inc.ajusteEditadoPor})`:""}</div>}
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={()=>setAjusteId(null)} className="px-3 py-2 rounded-lg text-xs font-bold bg-white border border-slate-200 text-slate-500">Cancelar</button>
                      <button onClick={()=>guardarAjuste(inc.id)} className="px-3 py-2 rounded-lg text-xs font-bold text-white" style={{background:"#b45309"}}>Guardar ajuste</button>
                    </div>
                  </div>
                )}

                {/* Render del incentivo */}
                {esRacha ? (
                  <RachaProgreso inc={inc} allData={allData} />
                ) : (()=>{
                  const p=calcularProgresoIncentivo(inc, allData);
                  return (
                    <div className="bg-white rounded-2xl shadow-sm border border-[#e8edf3] overflow-hidden">
                      <div className="px-4 py-3 flex items-center justify-between" style={{background:"#f9fafb"}}>
                        <div>
                          <div className="font-black text-[#1f2d3d] text-sm">{inc.nombre}</div>
                          <div className="text-[11px] text-slate-400"><Ico e="👤" className="mr-1.5" />{inc.agente||"Todos"} · {inc.fechaInicio} → {inc.fechaFin}</div>
                        </div>
                      </div>
                      <div className="p-4">
                        {inc.premio && <div className="text-xs text-[#b45309] bg-amber-50 rounded-lg px-2 py-1 mb-2 inline-block font-bold"><Ico e="🎁" className="mr-1.5" />{inc.premio}</div>}
                        {p.completado ? (
                          <div className="text-center py-2"><span className="text-2xl"><Ico e="🎉" /></span> <span className="font-black text-[#16a34a]">¡Completado!</span></div>
                        ) : (
                          <>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-[11px] font-bold text-slate-400 uppercase">Progreso {p.diasRestantes!==null?`· ${p.diasRestantes} días restantes`:""}</span>
                              <span className="text-lg font-black text-[#5b21b6]" style={{fontFamily:SERIF}}>{p.pct}%</span>
                            </div>
                            <MetaBar label="📅 Citas" actual={p.citas} meta={p.metaCitas} color="#16a34a" />
                            <MetaBar label="🎬 Demostraciones" actual={p.demos} meta={p.metaDemos} color="#7c3aed" />
                            <MetaBar label="💰 Ventas" actual={p.ventas} meta={p.metaVentas} color="#047857" />
                            <MetaBar label="💵 Valor vendido" actual={p.valor} meta={p.metaValor} color="#b45309" />
                          </>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
        )}
      </div>
      )}

      {showForm && <IncentivoForm item={editItem} forzarTipo={editItem?null:(tab==="racha"?"racha":"normal")} agentes={agentes} onSave={guardar} onClose={()=>{setShowForm(false);setEditItem(null);}} />}
    </div>
  );
}

// Formulario de incentivo
function IncentivoForm({ item, agentes, onSave, onClose, forzarTipo }) {
  const [tipoInc,setTipoInc]=useState(item?.tipo||forzarTipo||"normal"); // normal | racha
  const [nombre,setNombre]=useState(item?.nombre||"");
  const [agente,setAgente]=useState(item?.agente||(agentes?.[0]||""));
  const [periodo,setPeriodo]=useState(item?.periodo||"semanal");
  const [fechaInicio,setFechaInicio]=useState(item?.fechaInicio||hoyLocal());
  const [fechaFin,setFechaFin]=useState(item?.fechaFin||"");
  const [metaCitas,setMetaCitas]=useState(item?.metaCitas||"");
  const [metaDemos,setMetaDemos]=useState(item?.metaDemos||"");
  const [metaVentas,setMetaVentas]=useState(item?.metaVentas||"");
  const [metaValor,setMetaValor]=useState(item?.metaValor||"");
  const [premio,setPremio]=useState(item?.premio||"");
  const [descripcion,setDescripcion]=useState(item?.descripcion||"");
  // Racha: 4 semanas con metas y bono enlazado, editables
  const [semanas,setSemanas]=useState(item?.semanas || [
    { metaCitas:"", metaDemos:"", metaVentas:"2", bono:"$10" },
    { metaCitas:"", metaDemos:"", metaVentas:"2", bono:"$20" },
    { metaCitas:"", metaDemos:"", metaVentas:"2", bono:"$30" },
    { metaCitas:"", metaDemos:"", metaVentas:"2", bono:"$50 + cena" },
  ]);
  const setSemana=(i,campo,val)=>setSemanas(p=>p.map((s,j)=>j===i?{...s,[campo]:val}:s));
  const addSemana=()=>setSemanas(p=>[...p,{metaCitas:"",metaDemos:"",metaVentas:"",bono:""}]);
  const delSemana=(i)=>setSemanas(p=>p.length>1?p.filter((_,j)=>j!==i):p);

  // Calcular fecha fin automática según periodo
  const aplicarPeriodo=(p)=>{
    setPeriodo(p);
    if(p==="personalizado") return;
    const ini=new Date(fechaInicio+"T00:00:00");
    let dias=7;
    if(p==="quincenal") dias=15;
    if(p==="mensual") dias=30;
    const fin=new Date(ini); fin.setDate(fin.getDate()+dias-1);
    setFechaFin(fin.toISOString().slice(0,10));
  };

  const guardar=()=>{
    if(!nombre.trim()){alert("Ponle un nombre al incentivo");return;}
    if(tipoInc==="racha"){
      // Validar que cada semana tenga al menos una meta
      const algunaSinMeta=semanas.some(s=>!s.metaCitas && !s.metaDemos && !s.metaVentas);
      if(algunaSinMeta){alert("Cada semana de la racha necesita al menos una meta (citas, demos o ventas)");return;}
      onSave({tipo:"racha",nombre:nombre.trim(),agente,fechaInicio,semanas,descripcion:descripcion.trim(),premio:(semanas[semanas.length-1]?.bono||"").trim()});
      return;
    }
    if(!fechaFin){alert("Define la fecha final");return;}
    if(!metaCitas && !metaDemos && !metaVentas && !metaValor){alert("Define al menos una meta");return;}
    onSave({tipo:"normal",nombre:nombre.trim(),agente,periodo,fechaInicio,fechaFin,metaCitas,metaDemos,metaVentas,metaValor,premio:premio.trim(),descripcion:descripcion.trim()});
  };

  return (
    <Modal title={item?<><Ico e="✏" className="mr-1" />Editar incentivo</>:(forzarTipo==="racha"?<><Ico e="🔥" className="mr-1" />Crear racha</>:(forzarTipo==="normal"?<><Ico e="🎯" className="mr-1" />Crear meta normal</>:<><Ico e="🏆" className="mr-1" />Crear incentivo</>))} onClose={onClose}>
      <div className="space-y-3">
        {/* Selector de tipo: normal o racha */}
        {!forzarTipo && (
        <Field label="Tipo de incentivo">
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={()=>setTipoInc("normal")} className={`px-3 py-2.5 rounded-xl text-xs font-bold border-2 transition ${tipoInc==="normal"?"border-[#5b21b6] bg-[#5b21b6]/5 text-[#5b21b6]":"border-[#e5def4] text-slate-500"}`}><Ico e="🎯" className="mr-1.5" />Meta normal</button>
            <button type="button" onClick={()=>setTipoInc("racha")} className={`px-3 py-2.5 rounded-xl text-xs font-bold border-2 transition ${tipoInc==="racha"?"border-[#7c3aed] bg-[#7c3aed]/5 text-[#7c3aed]":"border-[#e5def4] text-slate-500"}`}><Ico e="🔥" className="mr-1.5" />Racha (4 semanas)</button>
          </div>
        </Field>
        )}

        <Field label="Nombre del incentivo"><input value={nombre} onChange={e=>setNombre(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" placeholder="Ej: Reto de la semana" /></Field>
        <Field label="Descripción"><textarea value={descripcion} onChange={e=>setDescripcion(e.target.value)} rows={2} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed] resize-none" placeholder="Describe la misión (opcional)" /></Field>
        <Field label="Agente asignado">
          <select value={agente} onChange={e=>setAgente(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:border-[#7c3aed]">
            {(agentes||[]).map(a=><option key={a} value={a}>{a}</option>)}
          </select>
        </Field>

        {tipoInc==="racha" ? (
          <>
            <Field label="Inicio de la racha"><input type="date" value={fechaInicio} onChange={e=>setFechaInicio(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" /></Field>
            <div className="text-[11px] font-bold text-[#7c3aed] uppercase tracking-wider pt-1"><Ico e="🔥" className="mr-1.5" />Semanas de la racha (metas y bono editables)</div>
            <div className="text-[10px] text-slate-400 -mt-1">Cumplir la meta de cada semana mantiene la racha. Falla 1 → usa la vida 🛡️. Falla 2 → vuelve a empezar. Completa todas → bono final + reinicia.</div>
            <div className="space-y-2">
              {semanas.map((s,i)=>(
                <div key={i} className="border-2 border-[#7c3aed]/15 rounded-xl p-2.5 bg-[#f9f5ff]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-black text-[#7c3aed]">Semana {i+1}</span>
                    {semanas.length>1 && <button type="button" onClick={()=>delSemana(i)} className="text-red-400 text-xs font-bold"><Ico e="✕" className="mr-1.5" />Quitar</button>}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 mb-2">
                    <div>
                      <div className="text-[9px] font-bold text-slate-400 mb-0.5"><Ico e="📅" className="mr-1.5" />Citas</div>
                      <input type="number" value={s.metaCitas} onChange={e=>setSemana(i,"metaCitas",e.target.value)} className="w-full border border-[#e5def4] rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[#7c3aed]" placeholder="0" />
                    </div>
                    <div>
                      <div className="text-[9px] font-bold text-slate-400 mb-0.5"><Ico e="🎬" className="mr-1.5" />Demos</div>
                      <input type="number" value={s.metaDemos} onChange={e=>setSemana(i,"metaDemos",e.target.value)} className="w-full border border-[#e5def4] rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[#7c3aed]" placeholder="0" />
                    </div>
                    <div>
                      <div className="text-[9px] font-bold text-slate-400 mb-0.5"><Ico e="💰" className="mr-1.5" />Ventas</div>
                      <input type="number" value={s.metaVentas} onChange={e=>setSemana(i,"metaVentas",e.target.value)} className="w-full border border-[#e5def4] rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[#7c3aed]" placeholder="0" />
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] font-bold text-slate-400 mb-0.5"><Ico e="🎁" className="mr-1.5" />Bono de la semana</div>
                    <input value={s.bono} onChange={e=>setSemana(i,"bono",e.target.value)} className="w-full border border-[#e5def4] rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[#7c3aed]" placeholder="Ej: $10, $50 + cena" />
                  </div>
                </div>
              ))}
            </div>
            <button type="button" onClick={addSemana} className="w-full px-3 py-2 rounded-xl text-xs font-bold text-[#7c3aed] border-2 border-dashed border-[#7c3aed]/30">+ Agregar semana</button>
          </>
        ) : (
          <>
            <Field label="Periodo">
              <div className="grid grid-cols-4 gap-1.5">
                {[["semanal","Semanal"],["quincenal","Quincenal"],["mensual","Mensual"],["personalizado","Personal."]].map(([v,l])=>(
                  <button key={v} type="button" onClick={()=>aplicarPeriodo(v)} className={`px-2 py-2 rounded-lg text-[11px] font-bold border-2 ${periodo===v?"border-[#5b21b6] bg-[#5b21b6]/5 text-[#5b21b6]":"border-[#e5def4] text-slate-500"}`}>{l}</button>
                ))}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Inicio"><input type="date" value={fechaInicio} onChange={e=>setFechaInicio(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" /></Field>
              <Field label="Fin"><input type="date" value={fechaFin} onChange={e=>setFechaFin(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" /></Field>
            </div>
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider pt-1">Metas (llena las que apliquen)</div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={<><Ico e="📅" className="mr-1" />Citas</>}><input type="number" value={metaCitas} onChange={e=>setMetaCitas(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" placeholder="0" /></Field>
              <Field label={<><Ico e="🎬" className="mr-1" />Demostraciones</>}><input type="number" value={metaDemos} onChange={e=>setMetaDemos(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" placeholder="0" /></Field>
              <Field label={<><Ico e="💰" className="mr-1" />Ventas</>}><input type="number" value={metaVentas} onChange={e=>setMetaVentas(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" placeholder="0" /></Field>
              <Field label={<><Ico e="💵" className="mr-1" />Valor vendido $</>}><input type="number" value={metaValor} onChange={e=>setMetaValor(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" placeholder="0" /></Field>
            </div>
            <Field label={<><Ico e="🎁" className="mr-1" />Premio / recompensa</>}><input value={premio} onChange={e=>setPremio(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" placeholder="Ej: $100 de bono / cena / día libre" /></Field>
          </>
        )}
        <button onClick={guardar} className="w-full px-4 py-3 rounded-xl text-sm font-bold text-white" style={{background:"#16a34a"}}><Ico e="💾" className="mr-1.5" />Guardar incentivo</button>
      </div>
    </Modal>
  );
}


// ─── RUTAS GUARDADAS ──────────────────────────────────────────
// Recolecta TODOS los clientes y referidos como candidatos para rutas.
function recolectarParaRutas(allData) {
  const out = [];
  ["agregados","prospectos","distribucion"].forEach(sec=>{
    (allData[sec]||[]).filter(c=>!c.eliminado).forEach(c=>{
      out.push({
        id: c.id, _tipo: sec, _origen: sec,
        nombre: c.nombre||"(Sin nombre)",
        telefono: c.telefono||c.telefonoMovil||"",
        direccion: c.direccion||"", ciudad: c.ciudad||"", cp: c.cp||"",
        estado: c.estado||"sin_estado",
      });
    });
  });
  (allData.referidos||[]).forEach(anf=>{
    (anf.referidos||[]).forEach((r,i)=>{
      if(!(r.nombre&&r.nombre!=="(Referido sin nombre)")&&!r.telefono) return;
      out.push({
        id: `${anf.id}::${i}`, _tipo: "referidos", _origen: "referidos",
        nombre: r.nombre||"(Referido)", _anfitrion: anf.anfitrion||"",
        telefono: r.telefono||"",
        direccion: r.direccion||"", ciudad: r.ciudad||"", cp: r.cp||"",
        estado: r.estado||"sin_estado",
      });
    });
  });
  return out;
}
// ¿Tiene dirección suficiente para visita? (calle con número)
function dirSuficiente(c) {
  const dir=(c.direccion||"").trim();
  const ciudad=(c.ciudad||"").trim().toLowerCase();
  return dir.length>0 && dir.toLowerCase()!==ciudad && /\d/.test(dir);
}
// Genera link de Google Maps con varias paradas
function rutaMapsLink(clientes) {
  const dirs = clientes.map(c=>{
    const partes=[c.direccion, c.ciudad, c.cp].filter(Boolean);
    return partes.join(", ");
  }).filter(Boolean);
  if(dirs.length===0) return "";
  if(dirs.length===1) return "https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(dirs[0]);
  const destino=encodeURIComponent(dirs[dirs.length-1]);
  const waypoints=dirs.slice(0,-1).map(encodeURIComponent).join("|");
  return `https://www.google.com/maps/dir/?api=1&destination=${destino}${waypoints?`&waypoints=${waypoints}`:""}&travelmode=driving`;
}

const ESTADO_RUTA={
  pendiente:{ico:"⏳", label:"Pendiente",bg:"#fef3e2",color:"#b45309"},
  proceso:{ico:"🚗", label:"En proceso",bg:"#e0edff",color:"#1d4ed8"},
  completada:{ico:"✅", label:"Completada",bg:"#e7f6ec",color:"#047857"},
};

function RutasSection({ rutas, setRutas, allData, agentes, agente, notify }) {
  const [showCrear,setShowCrear]=useState(false);
  const candidatos = recolectarParaRutas(allData);

  const guardarRuta=(ruta)=>{
    const nueva={...ruta, id:genId(), creado:new Date().toISOString(), estadoRuta:"pendiente"};
    setRutas(p=>[nueva,...p]);
    setShowCrear(false);
    if(notify) notify("datos", `🗺️ Nueva ruta: ${ruta.nombreRuta}`, `${ruta.clientes.length+ruta.referidos.length} paradas · ${ruta.ciudad||ruta.codigoPostal||"mixta"}`, "🗺️ Rutas");
  };
  const cambiarEstado=(id,estado)=>setRutas(p=>p.map(r=>r.id===id?{...r,estadoRuta:estado}:r));
  const eliminarRuta=(id)=>{ if(confirm("¿Eliminar esta ruta? Los clientes NO se borran, solo la ruta.")) setRutas(p=>p.filter(r=>r.id!==id)); };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-black text-[#5b21b6]" style={{fontFamily:SERIF}}><Ico e="🗺" className="mr-1.5" />Rutas de visita</h2>
        <p className="text-xs text-slate-400 mt-1 mb-3">Agrupa clientes y referidos por zona para planear tus visitas. Los clientes nunca se borran al agregarlos a una ruta.</p>
        <button onClick={()=>setShowCrear(true)} className="px-4 py-2.5 rounded-lg text-sm font-bold text-white" style={{background:RP.navy}}>+ Crear ruta</button>
      </div>

      {rutas.length===0 ? (
        <div className="bg-white rounded-2xl p-8 text-center shadow-sm border border-[#e8edf3]">
          <div className="mb-2 flex justify-center"><Ico e="🗺" size={36} strokeWidth={1.25} className="opacity-40" /></div>
          <div className="text-sm text-slate-400">Aún no hay rutas. Crea la primera para organizar tus visitas por zona.</div>
        </div>
      ) : (
        <div className="space-y-3">
          {rutas.map(ruta=>{
            const er=ESTADO_RUTA[ruta.estadoRuta]||ESTADO_RUTA.pendiente;
            const paradas=[...(ruta.clientes||[]),...(ruta.referidos||[])];
            const conDir=paradas.filter(p=>dirSuficiente(p));
            const mapsUrl=rutaMapsLink(conDir);
            return (
              <div key={ruta.id} className="bg-white rounded-2xl shadow-sm border border-[#e8edf3] overflow-hidden">
                <div className="px-4 py-3" style={{background:"#f9fafb"}}>
                  <div className="flex items-center justify-between">
                    <div className="font-black text-[#1f2d3d] text-sm">{ruta.nombreRuta}</div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{background:er.bg,color:er.color}}>{er.label}</span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {ruta.fechaRuta?`📅 ${ruta.fechaRuta} · `:""}{ruta.ciudad?`🏙️ ${ruta.ciudad} · `:""}{ruta.codigoPostal?`📮 ${ruta.codigoPostal} · `:""}{paradas.length} parada(s){ruta.agenteAsignado?` · 👤 ${ruta.agenteAsignado}`:""}
                  </div>
                </div>
                <div className="p-3">
                  <div className="space-y-1 max-h-52 overflow-y-auto mb-3">
                    {paradas.map((p,i)=>{
                      const ok=dirSuficiente(p);
                      return (
                        <div key={i} className="flex items-start gap-2 bg-[#f4f6f9] rounded-lg px-2.5 py-1.5 text-xs">
                          <span className="font-black text-[#7c3aed] shrink-0">{i+1}.</span>
                          <div className="flex-1 min-w-0">
                            <div className="font-bold text-slate-700 truncate">{p.nombre}{p._origen==="referidos"?" 🎁":""}</div>
                            <div className="text-[10px] text-slate-400 truncate">
                              {ok? `📍 ${[p.direccion,p.ciudad,p.cp].filter(Boolean).join(", ")}` : <span className="text-amber-500"><Ico e="⚠" className="mr-1.5" />Dirección incompleta{p.ciudad?` (${p.ciudad})`:""}</span>}
                            </div>
                          </div>
                          {p.telefono && <a href={"tel:"+p.telefono.replace(/[^0-9]/g,"").slice(-10)} className="text-[#16a34a] shrink-0"><Ico e="📞" /></a>}
                        </div>
                      );
                    })}
                  </div>
                  {mapsUrl && (
                    <a href={mapsUrl} target="_blank" rel="noreferrer" className="block w-full text-center px-4 py-2.5 rounded-lg text-sm font-bold text-white mb-2" style={{background:"#1a73e8"}}>
                      <Ico e="🗺" className="mr-1.5" />Abrir en Google Maps ({conDir.length} con dirección)
                    </a>
                  )}
                  <div className="flex gap-1.5 flex-wrap">
                    {Object.entries(ESTADO_RUTA).map(([k,v])=>(
                      <button key={k} onClick={()=>cambiarEstado(ruta.id,k)} className={`flex-1 text-[11px] font-bold py-1.5 px-2 rounded-lg border-2 transition ${ruta.estadoRuta===k?"border-current":"border-transparent"}`} style={{background:v.bg,color:v.color}}>{v.label}</button>
                    ))}
                  </div>
                  <button onClick={()=>eliminarRuta(ruta.id)} className="w-full text-xs font-bold text-red-400 mt-2 py-1"><Ico e="🗑" className="mr-1.5" />Eliminar ruta</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCrear && <RutaCrear candidatos={candidatos} agentes={agentes} agente={agente} onSave={guardarRuta} onClose={()=>setShowCrear(false)} />}
    </div>
  );
}

// Modal para crear una ruta (manual, por ciudad o por ZIP)
function RutaCrear({ candidatos, agentes, agente, onSave, onClose }) {
  const [modo,setModo]=useState("manual");  // manual | ciudad | zip
  const [nombreRuta,setNombreRuta]=useState("");
  const [fechaRuta,setFechaRuta]=useState(hoyLocal());
  const [agenteAsignado,setAgenteAsignado]=useState(agente||(agentes?.[0]||""));
  const [seleccion,setSeleccion]=useState([]);  // ids seleccionados (modo manual)
  const [ciudadSel,setCiudadSel]=useState("");
  const [zipSel,setZipSel]=useState("");

  // Listas de ciudades y ZIPs disponibles con conteo
  const ciudades={}; const zips={};
  candidatos.forEach(c=>{
    if(c.ciudad){ ciudades[c.ciudad]=(ciudades[c.ciudad]||0)+1; }
    if(c.cp){ zips[c.cp]=(zips[c.cp]||0)+1; }
  });
  const ciudadesOrd=Object.entries(ciudades).sort((a,b)=>b[1]-a[1]);
  const zipsOrd=Object.entries(zips).sort((a,b)=>b[1]-a[1]);

  const toggle=(id)=>setSeleccion(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);

  const construir=()=>{
    let elegidos=[];
    let ciudad="", codigoPostal="";
    if(modo==="manual"){
      elegidos=candidatos.filter(c=>seleccion.includes(c.id));
    } else if(modo==="ciudad"){
      if(!ciudadSel){alert("Elige una ciudad");return;}
      ciudad=ciudadSel;
      elegidos=candidatos.filter(c=>(c.ciudad||"").toLowerCase()===ciudadSel.toLowerCase());
    } else if(modo==="zip"){
      if(!zipSel){alert("Elige un código postal");return;}
      codigoPostal=zipSel;
      elegidos=candidatos.filter(c=>(c.cp||"")===zipSel);
    }
    if(elegidos.length===0){alert("No hay clientes para esta ruta");return;}
    if(!nombreRuta.trim()){alert("Ponle un nombre a la ruta");return;}
    const clientes=elegidos.filter(c=>c._origen!=="referidos");
    const referidos=elegidos.filter(c=>c._origen==="referidos");
    onSave({ nombreRuta:nombreRuta.trim(), fechaRuta, ciudad, codigoPostal, clientes, referidos, agenteAsignado });
  };

  const previewCount = modo==="manual" ? seleccion.length
    : modo==="ciudad" ? (ciudadSel?candidatos.filter(c=>(c.ciudad||"").toLowerCase()===ciudadSel.toLowerCase()).length:0)
    : (zipSel?candidatos.filter(c=>(c.cp||"")===zipSel).length:0);

  return (
    <Modal title="🗺️ Crear ruta" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Nombre de la ruta"><input value={nombreRuta} onChange={e=>setNombreRuta(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" placeholder="Ej: Visitas Temple lunes" /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Fecha"><input type="date" value={fechaRuta} onChange={e=>setFechaRuta(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed]" /></Field>
          <Field label="Agente"><select value={agenteAsignado} onChange={e=>setAgenteAsignado(e.target.value)} className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none focus:border-[#7c3aed]">{(agentes||[]).map(a=><option key={a} value={a}>{a}</option>)}</select></Field>
        </div>
        <Field label="¿Cómo armar la ruta?">
          <div className="grid grid-cols-3 gap-1.5">
            {[["manual","✋ Manual"],["ciudad","🏙️ Por ciudad"],["zip","📮 Por ZIP"]].map(([v,l])=>(
              <button key={v} type="button" onClick={()=>setModo(v)} className={`px-2 py-2 rounded-lg text-[11px] font-bold border-2 ${modo===v?"border-[#5b21b6] bg-[#5b21b6]/5 text-[#5b21b6]":"border-[#e5def4] text-slate-500"}`}>{l}</button>
            ))}
          </div>
        </Field>

        {modo==="manual" && (
          <div>
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Selecciona clientes ({seleccion.length})</div>
            <div className="max-h-56 overflow-y-auto space-y-1 bg-[#f4f6f9] rounded-xl p-2">
              {candidatos.map(c=>(
                <button key={c.id} type="button" onClick={()=>toggle(c.id)} className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs transition ${seleccion.includes(c.id)?"bg-[#5b21b6] text-white":"bg-white text-slate-700 border border-[#e8edf3]"}`}>
                  <span className="shrink-0">{seleccion.includes(c.id)?"☑️":"⬜"}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold truncate">{c.nombre}{c._origen==="referidos"?" 🎁":""}</div>
                    <div className={`text-[10px] truncate ${seleccion.includes(c.id)?"text-white/70":"text-slate-400"}`}>{[c.ciudad,c.cp].filter(Boolean).join(" · ")||"sin zona"}{dirSuficiente(c)?"":" ⚠️"}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {modo==="ciudad" && (
          <div>
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Elige ciudad</div>
            <div className="max-h-56 overflow-y-auto space-y-1 bg-[#f4f6f9] rounded-xl p-2">
              {ciudadesOrd.length===0 && <div className="text-xs text-slate-400 p-2">No hay ciudades registradas en tus clientes.</div>}
              {ciudadesOrd.map(([ciu,n])=>(
                <button key={ciu} type="button" onClick={()=>setCiudadSel(ciu)} className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-bold transition ${ciudadSel===ciu?"bg-[#5b21b6] text-white":"bg-white text-slate-700 border border-[#e8edf3]"}`}>
                  <span><Ico e="🏙" className="mr-1.5" />{ciu}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${ciudadSel===ciu?"bg-white/20":"bg-[#f1ecfd] text-[#5b21b6]"}`}>{n}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {modo==="zip" && (
          <div>
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Elige código postal</div>
            <div className="max-h-56 overflow-y-auto space-y-1 bg-[#f4f6f9] rounded-xl p-2">
              {zipsOrd.length===0 && <div className="text-xs text-slate-400 p-2">No hay códigos postales registrados en tus clientes.</div>}
              {zipsOrd.map(([z,n])=>(
                <button key={z} type="button" onClick={()=>setZipSel(z)} className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-bold transition ${zipSel===z?"bg-[#5b21b6] text-white":"bg-white text-slate-700 border border-[#e8edf3]"}`}>
                  <span><Ico e="📮" className="mr-1.5" />{z}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${zipSel===z?"bg-white/20":"bg-[#f1ecfd] text-[#5b21b6]"}`}>{n}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="bg-[#f1ecfd] rounded-xl px-3 py-2 text-xs font-bold text-[#5b21b6] text-center">{previewCount} parada(s) en esta ruta</div>
        <button onClick={construir} className="w-full px-4 py-3 rounded-xl text-sm font-bold text-white" style={{background:"#16a34a"}}><Ico e="💾" className="mr-1.5" />Guardar ruta</button>
      </div>
    </Modal>
  );
}


// ─── PESTAÑA SERVICIO ─────────────────────────────────────────
// Los servicios son citas (appts) con tipo "servicio".
// Cada servicio puede marcarse: realizado / no realizado, y guardar nota.
// El servicio SIEMPRE se ve rojo; solo el indicador "se realizó" se pone verde.
const SERVICIO_ESTADO = {
  pendiente:    { ico:"🔧", label:"Pendiente",     bg:"rgba(248,113,113,0.14)", color:"#FCA5A5", dot:"#ef4444" },
  realizado:    { ico:"✅", label:"Se realizó",    bg:"rgba(74,222,128,0.14)",  color:"#6EE7B7", dot:"#16a34a" },
  no_realizado: { ico:"❌", label:"No se realizó", bg:"rgba(248,113,113,0.14)", color:"#FCA5A5", dot:"#ef4444" },
};

// ── CARTUCHOS Y FILTROS (dentro de Servicios): todos los cambios ordenados
// por el más próximo, con ficha del cliente, llamada, WhatsApp listo y agendar cita.
function CartuchosServicioPanel({ allData, appts, setAppts, agente, notify }){
  const [busca,setBusca]=useState("");
  const noE=a=>(a||[]).filter(c=>!c.eliminado);
  const flat=[...noE(allData.agregados),...noE(allData.prospectos),...noE(allData.distribucion),...noE(allData.referidos)];
  const lista=calcularCartuchos(flat, appts, 36500) // ventana infinita → TODOS, del más próximo al más lejano
    .filter(x=>{ const q=(busca||"").toLowerCase(); return !q || (x.nombre||"").toLowerCase().includes(q) || (x.producto||"").toLowerCase().includes(q); });
  const vencidos=lista.filter(x=>x.vencido).length;
  const fFecha=(d)=>d.toLocaleDateString("es-MX",{day:"numeric",month:"short",year:"numeric"});
  const msgWA=(x)=>encodeURIComponent(`¡Hola ${(x.nombre||"").split(" ")[0]}! 👋 Le saluda ${agente||"su equipo"} de Royal Prestige. Le corresponde el cambio de ${x.producto||"su cartucho"}${x.vencido?" (ya está vencido ⚠️)":` el ${fFecha(x.proxFecha)}`}. ¿Qué día le viene bien para agendar su visita y dejar su agua como nueva? 💧`);
  const agendar=(x)=>{
    const fechaISO=new Date(Math.max(x.proxFecha.getTime(), Date.now())).toISOString().slice(0,10);
    setAppts(p=>[...(p||[]),{ id:genId(), tipo:"servicio", nombre:x.nombre, telefono:x.telefono||"", fecha:fechaISO, hora:"", notas:`🔔 Cambio de cartucho: ${x.producto||""}`.trim(), agente, creado:new Date().toISOString() }]);
    notify && notify("servicio",`📅 Servicio agendado: ${x.nombre}`,`Cambio de ${x.producto||"cartucho"} — ${fechaISO}. Ajusta la hora en Servicios/Agenda.`,"🔧 Servicios");
    alert(`✅ Cita de servicio creada para ${x.nombre} (${fechaISO}). Ajusta la hora en la pestaña Servicios.`);
  };
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <input className={inpLight+" flex-1"} placeholder="Buscar por cliente o producto…" value={busca} onChange={e=>setBusca(e.target.value)} />
        {vencidos>0 && <span className="shrink-0 text-[11px] font-black text-white bg-red-500 px-2.5 py-1.5 rounded-full"><Ico e="⚠" className="mr-1.5" />{vencidos} vencido(s)</span>}
      </div>
      {lista.length===0 && <div className="text-center py-12 text-slate-400"><div className="mb-3 flex justify-center"><Ico e="💧" size={36} strokeWidth={1.25} className="opacity-40" /></div><div className="text-sm font-bold">Sin cambios de cartucho registrados.</div><div className="text-xs mt-1">Se llenan solos al registrar ventas de filtros o purificador.</div></div>}
      <div className="space-y-2">
        {lista.map((x,i)=>{
          const tel=(x.telefono||"").replace(/\D/g,"");
          return (
            <div key={`cs-${i}`} className={`bg-white rounded-2xl border p-3 shadow-sm ${x.vencido?"border-red-300":"border-[#e8edf3]"}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm text-[#1f2d3d] truncate" style={{fontFamily:SERIF}}>{x.nombre}</div>
                  <div className="text-xs text-slate-500 truncate mt-0.5"><Ico e="💧" className="mr-1.5" />{x.producto||"Filtro"}{x.telefono?` · 📞 ${x.telefono}`:""}</div>
                  <div className="text-xs mt-1">
                    {x.vencido
                      ? <span className="font-black text-red-500"><Ico e="⚠" className="mr-1.5" />VENCIDO hace {Math.abs(x.diasFaltan)} día(s)</span>
                      : <span className="font-black text-teal-600">En {x.diasFaltan} día(s)</span>} · 🗓️ {fFecha(x.proxFecha)} · <span className="text-slate-400">ciclo desde {x.fechaVenta?String(x.fechaVenta).slice(0,10):"—"}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <div className="flex gap-1.5">
                    {tel && <a href={`tel:${tel}`} className="w-9 h-9 flex items-center justify-center rounded-lg text-white text-sm" style={{background:RP.blue}}><Ico e="📞" /></a>}
                    {tel && <a href={`https://wa.me/${tel}?text=${msgWA(x)}`} target="_blank" rel="noreferrer" className="w-9 h-9 flex items-center justify-center rounded-lg text-white text-sm" style={{background:"#25D366"}}>💬</a>}
                  </div>
                  <button onClick={()=>agendar(x)} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-white" style={{background:RP.navy}}><Ico e="📅" className="mr-1.5" />Agendar</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="text-[10px] text-slate-400 mt-3 text-center">Ordenado del cambio más próximo al más lejano · los vencidos van primero.</div>
    </div>
  );
}

function ServicioSection({ appts, setAppts, agente, notify, allData }) {
  const [vista,setVista]=useState("servicios"); // servicios | cartuchos
  const [filtro,setFiltro]=useState("todos"); // todos | pendiente | realizado | no_realizado
  const [expandido,setExpandido]=useState(null);
  const [notaEdit,setNotaEdit]=useState({});const [ventaForm,setVentaForm]=useState(null); // {servId, monto, prod}

  // Solo los appts de tipo servicio
  const servicios=(appts||[]).filter(a=>a.tipo==="servicio");
  const hoyISO=hoyLocal();

  // Estado derivado de cada servicio
  const estadoDe=(s)=> s.servicioResultado || "pendiente";

  const filtrados=servicios.filter(s=>{
    if(filtro==="todos") return true;
    return estadoDe(s)===filtro;
  }).sort((a,b)=>new Date(b.fecha||0)-new Date(a.fecha||0));

  const conteos={
    todos: servicios.length,
    pendiente: servicios.filter(s=>estadoDe(s)==="pendiente").length,
    realizado: servicios.filter(s=>estadoDe(s)==="realizado").length,
    no_realizado: servicios.filter(s=>estadoDe(s)==="no_realizado").length,
  };

  // Marcar resultado del servicio — mismo abanico que la agenda:
  // venta (con monto y producto), realizado, no recibió, no se visitó, reset.
  // La venta alimenta ventas/volumen de estadísticas (resultado demo_venta + monto)
  // y, si el producto tiene ciclo de mantenimiento, agenda el recordatorio.
  const marcarResultado=(servId, resultado, extra={})=>{
    const montoNum = resultado==="venta" ? Number(extra.monto)||0 : 0;
    const prodLabel = extra.producto || "";
    const meses = Number(extra.meses)||0;
    const sv = servicios.find(x=>x.id===servId);
    setAppts(p=>{
      let out = p.map(s=>{
        if(s.id!==servId) return s;
        const histPrev=s.servicioHistorial||[];
        const interno = resultado==="venta" ? "realizado" : (resultado==="no_recibio"||resultado==="no_visito") ? "no_realizado" : resultado==="reset" ? "pendiente" : resultado;
        return {
          ...s,
          servicioResultado:interno,
          // resultado estilo agenda → cuenta en Control de Actividad y Estadísticas
          ...(resultado==="venta" ? { resultado:"demo_venta", venta:true, monto:montoNum, producto:prodLabel||s.producto } :
              resultado==="no_recibio" ? { resultado:"no_recibio", venta:false } :
              resultado==="no_visito" ? { resultado:"no_visito", venta:false } :
              resultado==="reset" ? { resultado:"reset" } :
              resultado==="realizado" ? { resultado:"servicio_realizado" } : {}),
          servicioHistorial:[...histPrev,{resultado,monto:montoNum||undefined,producto:prodLabel||undefined,fecha:new Date().toISOString(),agente}],
          actualizado:new Date().toISOString(),
        };
      });
      // Recordatorio de mantenimiento (igual que en agenda): a +N meses
      if(resultado==="venta" && meses>0 && sv){
        const f=new Date(); f.setMonth(f.getMonth()+meses);
        out=[...out,{ id:genId(), tipo:"servicio", nombre:sv.nombre, telefono:sv.telefono||"", direccion:sv.direccion||"", ciudad:sv.ciudad||"",
          fecha:f.toISOString().slice(0,10)+"T09:00", producto:prodLabel, notas:`🔁 Mantenimiento ${prodLabel} (cada ${meses} meses)`, creado_por:agente }];
      }
      return out;
    });
    if(notify){
      const nom = sv?.nombre||"Cliente";
      if(resultado==="venta") notify("resultado", `💰 Venta en servicio por ${agente}`, `${nom} · ${prodLabel}${montoNum?` · $${montoNum}`:""}`, "🔧 Servicio");
      else if(resultado==="realizado") notify("resultado", `🔧 Servicio realizado`, nom, "🔧 Servicio");
    }
  };

  // Guardar nota del servicio (se acumula, no borra anterior)
  const guardarNota=(servId)=>{
    const texto=(notaEdit[servId]||"").trim();
    if(!texto) return;
    setAppts(p=>p.map(s=>{
      if(s.id!==servId) return s;
      const notasPrev=s.servicioNotas||[];
      return {
        ...s,
        servicioUltimaNota:texto,
        servicioNotas:[...notasPrev,{texto,fecha:new Date().toISOString(),agente}],
        actualizado:new Date().toISOString(),
      };
    }));
    setNotaEdit(p=>({...p,[servId]:""}));
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-black text-[#5b21b6]" style={{fontFamily:SERIF}}><Ico e="🔧" className="mr-1.5" />Servicios</h2>
        <p className="text-xs text-slate-400 mt-1">Servicios agendados, su resultado y notas. Conectados con el cliente.</p>
        <div className="flex gap-1.5 mt-3">
          {[["servicios","🔧","Servicios"],["cartuchos","💧","Cartuchos y filtros"]].map(([id,ico,label])=>(
            <button key={id} onClick={()=>setVista(id)}
              className={`flex-1 py-2 rounded-xl text-xs font-black transition ${vista===id?"text-white":"bg-white text-slate-500 border border-[#e8edf3]"}`}
              style={vista===id?{background:RP.navy}:{}}><span className="inline-flex items-center justify-center gap-1.5"><Ico e={ico} size={13} />{label}</span></button>
          ))}
        </div>
      </div>

      {vista==="cartuchos" ? (
        <CartuchosServicioPanel allData={allData||{}} appts={appts} setAppts={setAppts} agente={agente} notify={notify} />
      ) : (<>

      {/* Filtros por estado */}
      <div className="grid grid-cols-4 gap-1.5">
        {[
          {id:"todos",label:"Todos",n:conteos.todos},
          {id:"pendiente",ico:"⏳", label:"Pend.",n:conteos.pendiente},
          {id:"realizado",ico:"✅", label:"Hechos",n:conteos.realizado},
          {id:"no_realizado",ico:"❌", label:"No",n:conteos.no_realizado},
        ].map(t=>(
          <button key={t.id} onClick={()=>setFiltro(t.id)}
            className={`px-1 py-2.5 rounded-xl text-[11px] font-bold transition flex flex-col items-center gap-0.5 ${filtro===t.id?"text-white":"text-slate-600 bg-[#f4f6f9]"}`}
            style={filtro===t.id?{background:RP.navy}:{}}>
            <span>{t.label}</span>
            <span className={`text-base font-black ${filtro===t.id?"text-white":"text-[#5b21b6]"}`} style={{fontFamily:SERIF}}>{t.n}</span>
          </button>
        ))}
      </div>

      {filtrados.length===0 ? (
        <div className="bg-white rounded-2xl p-8 text-center shadow-sm border border-[#e8edf3]">
          <div className="mb-2 flex justify-center"><Ico e="🔧" size={36} strokeWidth={1.25} className="opacity-40" /></div>
          <div className="text-sm text-slate-400">No hay servicios {filtro!=="todos"?"en este estado":"agendados todavía"}.</div>
          <div className="text-xs text-slate-400 mt-1">Agenda un servicio desde una tarjeta de cliente (botón Agendar → tipo Servicio).</div>
        </div>
      ) : (
        <div className="space-y-3">
          {filtrados.map(s=>{
            const est=estadoDe(s);
            const info=SERVICIO_ESTADO[est];
            const d=s.fecha?new Date(s.fecha):null;
            const fechaStr=d?d.toLocaleDateString("es-MX",{weekday:"short",day:"numeric",month:"short"}):"Sin fecha";
            const horaStr=d?d.toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"}):"";
            const esHoy=s.fecha&&(s.fecha||"").slice(0,10)===hoyISO;
            const abierto=expandido===s.id;
            return (
              <div key={s.id} className="bg-white rounded-2xl shadow-sm border border-[#e8edf3] overflow-hidden">
                <div className="px-4 py-3" style={{background:info.bg}}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{background:info.dot}} />
                      <span className="font-black text-sm" style={{color:"#F4F4F1"}}>{s.nombre||"Cliente"}</span>
                      {esHoy && <span className="text-[9px] font-black text-white bg-[#16a34a] px-1.5 py-0.5 rounded-full">HOY</span>}
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full text-white" style={{background:est==="realizado"?"#16a34a":"#dc2626"}}>{info.label}</span>
                  </div>
                  <div className="text-[11px] mt-1" style={{color:"#A5A9B0"}}><Ico e="🗓" className="mr-1.5" />{fechaStr}{horaStr?<> · <Ico e="🕐" /> {horaStr}</>:null}{s.agente?<> · <Ico e="👤" /> {s.agente}</>:null}</div>
                </div>
                <div className="p-3">
                  {/* Info del cliente */}
                  <div className="space-y-1 text-xs mb-3">
                    {s.telefono && <div className="flex items-center gap-2"><span className="text-slate-400"><Ico e="📞" /></span><a href={"tel:"+(s.telefono||"").replace(/[^0-9]/g,"").slice(-10)} className="text-[#7c3aed] font-bold">{s.telefono}</a></div>}
                    {(s.direccion||s.ciudad) && <div className="flex items-start gap-2"><span className="text-slate-400"><Ico e="📍" /></span><span className="text-slate-600">{[s.direccion,s.ciudad,s.cp].filter(Boolean).join(", ")}</span></div>}
                    {s.producto && <div className="flex items-center gap-2"><span className="text-slate-400"><Ico e="🔧" /></span><span className="text-slate-600">{s.producto}</span></div>}
                    {s.servicioUltimaNota && <div className="flex items-start gap-2 bg-amber-50 rounded-lg px-2 py-1.5 mt-1"><span><Ico e="📌" /></span><span className="text-slate-700">{s.servicioUltimaNota}</span></div>}
                  </div>

                  {/* Botones de resultado — mismo abanico que la agenda */}
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <button onClick={()=>marcarResultado(s.id,"realizado")}
                      className={`px-3 py-2.5 rounded-xl text-xs font-bold transition ${est==="realizado"?"text-white ring-2 ring-offset-1 ring-emerald-500":"text-emerald-700 bg-emerald-50"}`}
                      style={est==="realizado"?{background:"#16a34a"}:{}}><Ico e="✅" className="mr-1.5" />Servicio realizado</button>
                    <button onClick={()=>setVentaForm(ventaForm&&ventaForm.servId===s.id?null:{servId:s.id,monto:"",prod:""})}
                      className="px-3 py-2.5 rounded-xl text-xs font-bold text-white transition"
                      style={{background:"#047857"}}><Ico e="💰" className="mr-1.5" />Venta</button>
                    <button onClick={()=>marcarResultado(s.id,"no_recibio")}
                      className="px-3 py-2.5 rounded-xl text-xs font-bold text-white transition" style={{background:"#dc2626"}}><Ico e="🚪" className="mr-1.5" />No recibió</button>
                    <button onClick={()=>marcarResultado(s.id,"no_visito")}
                      className="px-3 py-2.5 rounded-xl text-xs font-bold text-white transition" style={{background:"#9333ea"}}><Ico e="🚷" className="mr-1.5" />No se visitó</button>
                  </div>
                  <button onClick={()=>marcarResultado(s.id,"reset")}
                    className="w-full px-3 py-2 rounded-xl text-xs font-bold text-white mb-2" style={{background:"#0891b2"}}><Ico e="🔄" className="mr-1.5" />Reset servicio (queda pendiente)</button>
                  {ventaForm && ventaForm.servId===s.id && (
                    <div className="mb-2 p-2.5 rounded-xl border-2 border-emerald-200 bg-emerald-50 space-y-2">
                      <select className="w-full border border-emerald-300 rounded-lg px-2 py-2 text-xs bg-white font-bold"
                        value={ventaForm.prod} onChange={e=>setVentaForm({...ventaForm,prod:e.target.value})}>
                        <option value="">Producto vendido…</option>
                        {PRODUCTOS_VENTA.flatMap(p=>p.sub?p.sub.map(sb=>({id:p.id+"::"+sb.id,label:sb.label,meses:sb.meses||0})):[{id:p.id,label:p.label,meses:p.meses||0}]).map(o=>(
                          <option key={o.id} value={o.label+"|"+o.meses}>{o.label}{o.meses?` (mant. ${o.meses}m)`:""}</option>
                        ))}
                      </select>
                      <input type="number" inputMode="decimal" className="w-full border border-emerald-300 rounded-lg px-2 py-2 text-xs bg-white"
                        placeholder="Monto de la venta" value={ventaForm.monto} onChange={e=>setVentaForm({...ventaForm,monto:e.target.value})} />
                      <button disabled={!ventaForm.prod} onClick={()=>{ const [lbl,ms]=ventaForm.prod.split("|"); marcarResultado(s.id,"venta",{monto:ventaForm.monto,producto:lbl,meses:+ms||0}); setVentaForm(null); }}
                        className="w-full px-3 py-2 rounded-lg text-xs font-black text-white disabled:opacity-40" style={{background:"#047857"}}>Registrar venta ✓</button>
                    </div>
                  )}

                  {/* Detalles + nota */}
                  <button onClick={()=>setExpandido(abierto?null:s.id)} className="w-full flex items-center justify-between px-3 py-2 rounded-xl border border-[#e5def4] bg-[#f4f6f9] text-xs font-bold text-[#5b21b6]">
                    <span><Ico e="📝" className="mr-1.5" />{abierto?"Ocultar":"Ver detalles y nota"}</span>
                    <span className={`transition-transform duration-200 ${abierto?"rotate-180":""}`}>▾</span>
                  </button>
                  {abierto && (
                    <div className="mt-2 space-y-2">
                      <div className="flex gap-1.5">
                        <input value={notaEdit[s.id]||""} onChange={e=>setNotaEdit(p=>({...p,[s.id]:e.target.value}))}
                          onKeyDown={e=>{if(e.key==="Enter")guardarNota(s.id);}}
                          placeholder="Escribir nota del servicio…"
                          className="flex-1 border border-[#e5def4] rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#7c3aed]" />
                        <button onClick={()=>guardarNota(s.id)} disabled={!(notaEdit[s.id]||"").trim()}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-40" style={{background:"#16a34a"}}>Guardar</button>
                      </div>
                      {(s.servicioNotas||[]).length>0 && (
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                          <div className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Historial de notas</div>
                          {[...(s.servicioNotas||[])].reverse().map((n,i)=>{
                            const nd=new Date(n.fecha);
                            return (
                              <div key={i} className="bg-[#f4f6f9] rounded-lg px-2 py-1.5 text-[11px]">
                                <div className="text-slate-700">{n.texto}</div>
                                <div className="text-[9px] text-slate-400 mt-0.5"><Ico e="📅" className="mr-1.5" />{nd.toLocaleDateString("es-MX",{day:"numeric",month:"short"})} 🕐 {nd.toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"})}{n.agente?<> · <Ico e="👤" /> {n.agente}</>:null}</div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {(s.servicioHistorial||[]).length>0 && (
                        <div className="text-[10px] text-slate-400">
                          Último cambio de resultado: {SERVICIO_ESTADO[s.servicioHistorial[s.servicioHistorial.length-1].resultado]?.label} · {new Date(s.servicioHistorial[s.servicioHistorial.length-1].fecha).toLocaleDateString("es-MX",{day:"numeric",month:"short"})}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      </>)}
    </div>
  );
}


// ─── CONFIGURACIÓN — cambiar claves de acceso ─────────────────
function ConfigSection({ agenteActivo, onCerrarSesion, rolActivo, emailActivo, cuentasCustom, onSaveCuentas, allData, onLimpiarSinTelefono, onExtraerCP, cumpleMsgTpl, onSaveCumpleMsg }) {
  const esDistribuidor = normalizarRol(rolActivo)==="Distribuidor"; // solo el distribuidor gestiona usuarios
  // ── Panel de usuarios: correo → nombre y rol (vive en Firebase, sin redesplegar) ──
  const [rNombre,setRNombre]=useState("");
  const [rEmail,setREmail]=useState("");
  const [rRol,setRRol]=useState(ROLES_DISPONIBLES[2]);
  const [rMsg,setRMsg]=useState("");
  const [rEdit,setREdit]=useState(null);
  // ── Editor del mensaje de cumpleaños ──
  const [tplDraft,setTplDraft]=useState(cumpleMsgTpl || CUMPLE_MSG_DEFAULT);
  const [tplMsg,setTplMsg]=useState("");
  const guardarTpl=()=>{
    onSaveCumpleMsg((tplDraft||"").trim());
    setTplMsg("✅ Mensaje guardado. Ya se usa en el panel y en la pestaña Cumpleaños.");
    setTimeout(()=>setTplMsg(""),3500);
  };
  const restaurarTpl=()=>{ setTplDraft(CUMPLE_MSG_DEFAULT); onSaveCumpleMsg(""); setTplMsg("✅ Mensaje original restaurado."); setTimeout(()=>setTplMsg(""),3000); };

  const CORREOS_FIJOS = [CUENTA_ROOT];  // solo la llave maestra es intocable
  const guardarCuenta=()=>{
    const em=(rEmail||"").trim().toLowerCase();
    const nom=(rNombre||"").trim();
    if(!nom){ setRMsg("❌ Escribe el nombre."); return; }
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)){ setRMsg("❌ Correo inválido."); return; }
    if(CORREOS_FIJOS.includes(em)){ setRMsg("❌ Ese correo es un usuario fijo del sistema y no se edita aquí."); return; }
    if(!rEdit && (cuentasCustom||[]).some(u=>(u.email||"").toLowerCase()===em)){ setRMsg("❌ Ese correo ya está en la lista."); return; }
    onSaveCuentas(prev=>{
      const arr=(prev||[]).filter(u=>(u.email||"").toLowerCase()!==em);
      return [...arr, { email:em, nombre:nom, rol:rRol, creado:new Date().toISOString() }];
    });
    setRMsg(rEdit?"✅ Rol actualizado.":"✅ Usuario autorizado. Recuerda crear su credencial en Firebase.");
    setRNombre("");setREmail("");setRRol(ROLES_DISPONIBLES[2]);setREdit(null);
    setTimeout(()=>setRMsg(""),3500);
  };
  const editarCuenta=(u)=>{ setREdit(u.email); setRNombre(u.nombre||""); setREmail(u.email||""); setRRol(u.rol||ROLES_DISPONIBLES[2]); setRMsg(""); };
  const eliminarCuenta=(em)=>{
    if(!confirm("¿Quitar el acceso de "+em+" a la app?\n\nSus clientes, llamadas e historial se conservan.\n\nPara bloqueo TOTAL recuerda también:\n1. Quitar su correo de las reglas de Firestore\n2. Deshabilitar su cuenta en Firebase Authentication")) return;
    onSaveCuentas(prev=>(prev||[]).filter(u=>(u.email||"").toLowerCase()!==(em||"").toLowerCase()));
  };

  return (
    <div className="space-y-5">
      {esDistribuidor && (
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-[#e8edf3]">
        <div className="text-base font-bold text-[#1f2d3d] mb-1"><Ico e="👥" className="mr-1.5" />Usuarios y roles</div>
        <div className="text-xs text-slate-400 mb-3">Aquí administras quién entra a la app y con qué rol. Los cambios se sincronizan al instante en todos los dispositivos — sin tocar código ni redesplegar.</div>
        <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 mb-4 leading-relaxed">
          <div className="font-black mb-1">Para dar de alta a alguien (3 pasos):</div>
          <div className="mb-0.5"><b>1.</b> Firebase Console → <b>Authentication</b> → Add user (su correo y clave)</div>
          <div className="mb-0.5"><b>2.</b> Firebase Console → <b>Firestore → Reglas</b> → agrega su correo a la lista</div>
          <div><b>3.</b> Aquí abajo: escribe su nombre, correo y rol → <b>Autorizar</b></div>
        </div>
        {rMsg && <div className={`mb-3 text-sm font-bold rounded-xl px-3 py-2 ${rMsg.startsWith("✅")?"text-emerald-700 bg-emerald-50 border border-emerald-200":"text-red-500 bg-red-50 border border-red-200"}`}><Msg>{rMsg}</Msg></div>}
        <div className="space-y-2 mb-4">
          <input type="text" value={rNombre} onChange={e=>setRNombre(e.target.value)} placeholder="Nombre (ej. María Pérez)"
            className="w-full border-2 border-[#e8edf3] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#2f6fed]" />
          <input type="email" inputMode="email" autoCapitalize="none" value={rEmail} onChange={e=>setREmail(e.target.value)} placeholder="correo@gmail.com" disabled={!!rEdit}
            className="w-full border-2 border-[#e8edf3] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#2f6fed] disabled:bg-slate-50 disabled:text-slate-400" />
          <select value={rRol} onChange={e=>setRRol(e.target.value)}
            className="w-full border-2 border-[#e8edf3] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#2f6fed] bg-white">
            {ROLES_DISPONIBLES.map(r=><option key={r} value={r}>{r}</option>)}
          </select>
          <div className="flex gap-2">
            <button onClick={guardarCuenta} className="flex-1 text-white font-bold px-3 py-2 rounded-lg text-sm" style={{background:RP.blue}}>{rEdit?"Guardar cambios":"+ Autorizar usuario"}</button>
            {rEdit && <button onClick={()=>{setREdit(null);setRNombre("");setREmail("");setRRol(ROLES_DISPONIBLES[2]);setRMsg("");}} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-400 border-2 border-[#e8edf3]">Cancelar</button>}
          </div>
        </div>
        <div className="text-[10px] font-black text-slate-400 uppercase tracking-wide mb-2">Usuarios autorizados</div>
        <div className="space-y-2">
          {/* UNA sola lista: la llave maestra primero (🔑, intocable) y después
              todos los demás, cada uno con Editar y Eliminar. */}
          {[
            { email:CUENTA_ROOT, ...(CUENTAS_DINAMICAS[CUENTA_ROOT]||CUENTA_ROOT_DATOS), _root:true },
            ...(cuentasCustom||[]).filter(u=>(u.email||"").toLowerCase()!==CUENTA_ROOT)
          ].map(u=>(
            <div key={u.email} className={`flex items-center justify-between border-2 rounded-xl p-2.5 ${u._root?"border-[#eef1f5] bg-slate-50/50":"border-[#e8edf3]"}`}>
              <div className="min-w-0">
                <div className="font-bold text-sm text-[#1f2d3d] truncate">{u.nombre}</div>
                <div className="text-[10px] text-slate-400 truncate">{u.email}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[9px] font-black text-slate-500 uppercase">{u.rol}</span>
                {u._root
                  ? <span className="text-[9px] text-slate-300 font-bold" title="Llave maestra — no se puede quitar"><Ico e="🔑" /></span>
                  : <>
                      <button onClick={()=>editarCuenta(u)} className="text-xs font-bold px-2 py-1 rounded-lg text-white" style={{background:RP.blue}}>Editar</button>
                      <button onClick={()=>eliminarCuenta(u.email)} className="text-sm px-1" title="Quitar acceso"><Ico e="🗑" /></button>
                    </>}
              </div>
            </div>
          ))}
          {!(cuentasCustom||[]).filter(u=>(u.email||"").toLowerCase()!==CUENTA_ROOT).length && <div className="text-[11px] text-slate-400 text-center py-2">Solo está la llave maestra. Autoriza usuarios con el formulario de arriba.</div>}
        </div>
      </div>
      )}
      {/* 🎂 MENSAJE DE CUMPLEAÑOS — editable, se sincroniza a todos los teléfonos */}
      {esDistribuidor && (
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-[#e8edf3]">
        <div className="text-base font-bold text-[#1f2d3d] mb-1"><Ico e="🎂" className="mr-1.5" />Mensaje de cumpleaños</div>
        <div className="text-xs text-slate-400 mb-3">Este texto se envía con los botones 💬 WA y SMS de cumpleaños (panel y pestaña). Escribe <b>{"{nombre}"}</b> donde quieras que aparezca el primer nombre del cumpleañero.</div>
        {tplMsg && <div className="mb-3 text-sm font-bold rounded-xl px-3 py-2 text-emerald-700 bg-emerald-50 border border-emerald-200"><Msg>{tplMsg}</Msg></div>}
        <textarea value={tplDraft} onChange={e=>setTplDraft(e.target.value)} rows={8}
          className="w-full border-2 border-[#e5def4] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-[#7c3aed] leading-relaxed" />
        <div className="mt-2 text-[11px] text-slate-400 bg-[#f4f6f9] rounded-xl px-3 py-2 leading-relaxed">
          <b>Vista previa:</b> {(tplDraft||"").split("{nombre}").join("María").slice(0,220)}{(tplDraft||"").length>220?"…":""}
        </div>
        <div className="flex gap-2 mt-3">
          <button onClick={guardarTpl} className="flex-1 text-white font-bold px-3 py-2.5 rounded-xl text-sm" style={{background:"#16a34a"}}><Ico e="💾" className="mr-1.5" />Guardar mensaje</button>
          <button onClick={restaurarTpl} className="px-3 py-2.5 rounded-xl text-sm font-bold text-slate-500 border-2 border-[#e8edf3]">Restaurar original</button>
        </div>
      </div>
      )}

      {/* Claves locales, crear usuario y preguntas de seguridad: ELIMINADOS.
          El acceso es 100% Firebase: la clave se cambia con "¿Olvidaste tu clave?"
          en la pantalla de entrada, y los usuarios se gestionan arriba. */}

      {/* Herramienta: limpiar registros sin teléfono (solo admin/distribuidor) */}
      {(normalizarRol(rolActivo)==="Distribuidor"||normalizarRol(rolActivo)==="Supervisor") && (()=>{
        const sinTel=(arr)=>(allData?.[arr]||[]).filter(c=>!c.eliminado && (c.telefono||"").replace(/[^0-9]/g,"").length<10).length;
        const total=sinTel("agregados")+sinTel("prospectos")+sinTel("distribucion");
        return (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-[#e8edf3]">
            <div className="text-base font-bold text-[#1f2d3d] mb-1"><Ico e="🧹" className="mr-1.5" />Limpiar datos sin teléfono</div>
            <div className="text-sm text-slate-500 mb-3">
              {total>0
                ? <>Hay <strong className="text-red-500">{total}</strong> registro(s) sin teléfono válido. Puedes moverlos a la papelera.</>
                : <><Ico e="✅" className="mr-1.5" />Todos los registros tienen teléfono. Nada que limpiar.</>}
            </div>
            <button onClick={onLimpiarSinTelefono} disabled={total===0}
              className={`w-full px-4 py-3 rounded-xl text-sm font-bold border ${total>0?"text-amber-700 bg-amber-50 border-amber-200":"text-slate-400 bg-slate-50 border-slate-200"}`}>
              🧹 Revisar y limpiar sin teléfono{total>0?` (${total})`:""}
            </button>
          </div>
        );
      })()}

      {/* Herramienta: extraer código postal de la dirección a su casilla (solo admin/distribuidor) */}
      {(normalizarRol(rolActivo)==="Distribuidor"||normalizarRol(rolActivo)==="Supervisor") && (()=>{
        // Cuenta registros que NO tienen cp en su casilla pero SÍ tienen un CP de 5 dígitos en la dirección
        const sinCP=(arr)=>(allData?.[arr]||[]).filter(c=>{
          if(c.eliminado) return false;
          const yaCP=String(c.cp||"").replace(/\D/g,"").length===5;
          if(yaCP) return false;
          return zipDesdeTexto(c.direccion||"").length===5;
        }).length;
        const total=sinCP("agregados")+sinCP("prospectos")+sinCP("distribucion");
        return (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-[#e8edf3]">
            <div className="text-base font-bold text-[#1f2d3d] mb-1"><Ico e="📮" className="mr-1.5" />Separar código postal de la dirección</div>
            <div className="text-sm text-slate-500 mb-3">
              {total>0
                ? <>Hay <strong className="text-[#5b21b6]">{total}</strong> cliente(s) que tienen el código postal escrito dentro de la dirección. Puedo copiarlo a su casilla de C.P. para que la búsqueda sea más fácil.</>
                : <><Ico e="✅" className="mr-1.5" />Todos los códigos postales ya están en su casilla. Nada que separar.</>}
            </div>
            <button onClick={onExtraerCP} disabled={total===0}
              className={`w-full px-4 py-3 rounded-xl text-sm font-bold border ${total>0?"text-[#5b21b6] bg-[#f1ecfd] border-[#ddd1f7]":"text-slate-400 bg-slate-50 border-slate-200"}`}>
              📮 Separar código postal{total>0?` (${total})`:""}
            </button>
          </div>
        );
      })()}

      <div className="bg-white rounded-2xl p-5 shadow-sm border border-[#e8edf3]">
        <div className="text-base font-bold text-[#1f2d3d] mb-1"><Ico e="👤" className="mr-1.5" />Sesión actual</div>
        <div className="text-sm text-slate-500 mb-4">Estás dentro como <strong className="text-[#5b21b6]">{agenteActivo}</strong></div>
        <button onClick={onCerrarSesion} className="w-full px-4 py-3 rounded-xl text-sm font-bold text-red-500 bg-red-50 border border-red-200"><Ico e="🚪" className="mr-1.5" />Cerrar sesión</button>
      </div>
    </div>
  );
}

// ─── PANTALLA DE LOGIN ────────────────────────────────────────
// ─── LOGIN CON FIREBASE (correo + clave) ──────────────────────
function FirebaseLoginScreen({ onLogin, onReset, error, busy }) {
  const [email,setEmail]=useState("");
  const [clave,setClave]=useState("");
  const [verClave,setVerClave]=useState(false);
  const [resetMsg,setResetMsg]=useState("");

  const entrar=()=>{ if(email.trim() && clave) onLogin(email, clave); };
  const recuperar=async ()=>{
    if(!email.trim()){ setResetMsg("Escribe tu correo arriba y vuelve a tocar."); return; }
    setResetMsg("Enviando…");
    const ok=await onReset(email);
    setResetMsg(ok
      ? "✅ Te enviamos un correo para restablecer tu clave. Revisa tu bandeja (y spam)."
      : "No se pudo enviar. Revisa que el correo esté bien escrito.");
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden" style={{background:RP.navyDark}}>
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 w-[640px] h-[640px] rounded-full opacity-[0.06]"
        style={{background:"radial-gradient(circle, #C7CCD1 0%, transparent 60%)"}} />
      <div className="w-full max-w-md relative">
        <div className="text-center mb-8 flex flex-col items-center">
          <Brand />
          <div className="text-[#717680] text-xs mt-3 font-semibold uppercase tracking-[0.22em]">CRM de Telemarketing</div>
        </div>

        <div className="rounded-2xl p-7 shadow-2xl" style={{background:RP.navy,border:`1px solid ${RP.silver2}`}}>
          <label className="block text-[11px] font-bold uppercase tracking-[0.14em] mb-1.5 text-[#A5A9B0]">Correo</label>
          <input type="email" value={email} autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={e=>{setEmail(e.target.value);setResetMsg("");}}
            onKeyDown={e=>{if(e.key==="Enter")entrar();}}
            className="w-full rounded-xl px-4 py-3.5 text-base bg-[#0B0E12] text-[#F4F4F1] border border-white/12 focus:outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20 transition placeholder:text-[#717680] mb-4"
            placeholder="tucorreo@gmail.com" autoFocus />

          <label className="block text-[11px] font-bold uppercase tracking-[0.14em] mb-1.5 text-[#A5A9B0]">Clave</label>
          <div className="relative mb-5">
            <input type={verClave?"text":"password"} value={clave}
              onChange={e=>setClave(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter")entrar();}}
              className="w-full rounded-xl px-4 py-3.5 text-base bg-[#0B0E12] text-[#F4F4F1] border border-white/12 focus:outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20 transition placeholder:text-[#717680] pr-12"
              placeholder="Tu clave" />
              <button onClick={()=>setVerClave(p=>!p)} aria-label={verClave?"Ocultar clave":"Mostrar clave"} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#717680] hover:text-[#A5A9B0] transition"><Ico e={verClave?"🙈":"👁️"} size={18} /></button>
          </div>

          {error && <div className="mb-3 text-sm font-semibold text-[#FCA5A5] bg-[#F87171]/10 border border-[#F87171]/30 rounded-xl px-3 py-2">{error}</div>}
          {resetMsg && <div className="mb-3 text-sm font-semibold text-[#F4F4F1] bg-white/5 border border-white/12 rounded-xl px-3 py-2">{resetMsg}</div>}

          <button onClick={entrar} disabled={busy}
            className="group w-full px-4 py-3.5 rounded-xl text-base font-bold tracking-tight flex items-center justify-center gap-2 hover:brightness-95 transition active:scale-[0.98] disabled:opacity-40"
            style={{background:RP.btn,color:RP.btnText}}>
            {busy ? "Entrando…" : <>INICIAR SESIÓN <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"><path d="M7 17L17 7M9 7h8v8" /></svg></>}
          </button>

          <button onClick={recuperar} className="w-full mt-4 text-[11px] font-bold text-[#A5A9B0] hover:text-[#F4F4F1] transition">
            ¿Olvidaste tu clave?
          </button>

          <div className="mt-5 pt-4 border-t border-white/10 text-[11px] text-[#717680] text-center leading-relaxed">
            Entra con el correo y la clave que te asignaron. ¿Sin acceso? Pídeselo a tu administrador.
          </div>
        </div>
      </div>
    </div>
  );
}

// (El LoginScreen viejo de claves locales fue eliminado — el login es 100% Firebase.)

export default function App() {
  const [tab,setTab]=useState("inicio");const [sideOpen,setSideOpen]=useState(false);const [showAI,setShowAI]=useState(false);const [showCSV,setShowCSV]=useState(false);
  const [dbOpen,setDbOpen]=useState(false); // grupo desplegable "Base de datos" en el menú lateral
  const role="admin"; // todos tienen acceso completo
  // ── Firebase Auth: estado de sesión ──
  const [authUser,setAuthUser]=useState(null);     // usuario de Firebase, o null
  const [authReady,setAuthReady]=useState(false);  // ya sabemos si hay sesión o no
  const [loginError,setLoginError]=useState("");
  const [loginBusy,setLoginBusy]=useState(false);
  useEffect(()=>{
    let alive=true;
    getAuth().then(auth=>{ if(alive) auth.onAuthStateChanged(u=>{ setAuthUser(u||null); setAuthReady(true); }); })
             .catch(()=>{ if(alive) setAuthReady(true); });
    return ()=>{ alive=false; };
  },[]);

  // Identidad y rol salen del correo autenticado (no de claves en el código)
  const email=(authUser?.email||"").trim().toLowerCase();

  // El estado se carga para cualquier usuario autenticado en Firebase; la autorización
  // (fija o dinámica) se resuelve después, cuando ya tenemos state.cuentasCustom.
  const [state,setState,synced,fbError,reintentarFb]=useSharedState(authReady && !!authUser);
  // Sincroniza el mapa dinámico ANTES de resolver el rol (corre en cada render, es barato)
  setCuentasDinamicas(state?.cuentasCustom||[]);
  setCumpleMsgTpl(state?.cumpleMsgTpl||"");
  // ── MIGRACIÓN ÚNICA: si Firebase todavía no tiene la lista de cuentas, se
  // siembra con SEMILLA_CUENTAS. Corre una sola vez; después el panel manda. ──
  const semillaHecha=useRef(false);
  useEffect(()=>{
    if(semillaHecha.current) return;
    if(!authReady || !authUser || !synced || !state) return;
    if((state.cuentasCustom||[]).length>0){ semillaHecha.current=true; return; }
    semillaHecha.current=true;
    setState(s=>((s.cuentasCustom||[]).length>0 ? s : {...s, cuentasCustom:SEMILLA_CUENTAS}));
  },[authReady, authUser, synced, state, setState]);
  const emailOk=cuentaAutorizada(email);
  const cuenta=cuentaDeEmail(email);
  const agenteActivo=cuenta.nombre;
  const rolUsuario=cuenta.rol;
  const puedeGestionarIncentivos = puedeCrearIncentivosRol(rolUsuario);
  const [showNotifs,setShowNotifs]=useState(false);

  const iniciarSesion=async(correo,clave)=>{
    setLoginError(""); setLoginBusy(true);
    try {
      const auth=await getAuth();
      await auth.signInWithEmailAndPassword((correo||"").trim(), clave);
      // onAuthStateChanged actualiza authUser solo
    } catch(e){
      const c=e?.code||"";
      setLoginError(c.includes("too-many") ? "Demasiados intentos. Espera un momento e intenta de nuevo." : "Correo o clave incorrectos.");
    } finally { setLoginBusy(false); }
  };
  const recuperarClave=async(correo)=>{
    try { const auth=await getAuth(); await auth.sendPasswordResetEmail((correo||"").trim()); return true; }
    catch { return false; }
  };
  const cerrarSesion=async()=>{ try { const auth=await getAuth(); await auth.signOut(); } catch {} };

  // ── RESET AUTOMÁTICO A LAS 12:00 AM (zona horaria local) ──
  // Solo refresca las VISTAS y CONTADORES diarios (llamadas de hoy, agenda del día,
  // estadísticas diarias). NO borra datos históricos: citas, llamadas, servicios,
  // ventas e incentivos se conservan porque viven en el estado compartido.
  const [hoyTick,setHoyTick]=useState(()=>hoyLocal());
  useEffect(()=>{
    // Calcular ms hasta la próxima medianoche local
    const programarMedianoche=()=>{
      const ahora=new Date();
      const manana=new Date(ahora.getFullYear(),ahora.getMonth(),ahora.getDate()+1,0,0,5,0); // 00:00:05
      return manana.getTime()-ahora.getTime();
    };
    let timeout;
    const tick=()=>{
      setHoyTick(hoyLocal()); // cambia el día → re-render de vistas diarias
      timeout=setTimeout(tick, programarMedianoche());
    };
    timeout=setTimeout(tick, programarMedianoche());
    // Respaldo: revisar cada minuto por si el dispositivo estuvo suspendido
    const intervalo=setInterval(()=>{
      const hoyReal=hoyLocal();
      setHoyTick(prev=> prev!==hoyReal ? hoyReal : prev);
    }, 60000);
    return ()=>{ clearTimeout(timeout); clearInterval(intervalo); };
  },[]);

  useNotifPermission();
  const {notifs,noLeidas,notify,marcarLeidas,marcarUnaLeida}=useNotificaciones(state,setState,agenteActivo);

  // ── Revisar cumpleaños y notificar 2 días antes + el día ──
  useEffect(()=>{
    if(!synced) return;
    const parseMesDia=(fc)=>{
      if(!fc) return null; let m,d;
      if(/^\d{4}-\d{2}-\d{2}$/.test(fc)){const p=fc.split("-");m=+p[1]-1;d=+p[2];}
      else if(/^\d{1,2}-\d{1,2}$/.test(fc)){const p=fc.split("-");m=+p[0]-1;d=+p[1];}
      else if(/^\d{1,2}\/\d{1,2}$/.test(fc)){const p=fc.split("/");m=+p[0]-1;d=+p[1];}
      else return null;
      return {mes:m,dia:d};
    };
    // Combinar manuales + distribución
    const normN=(s)=>(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ").trim();
    const manuales=(state.cumpleanos||[]).map(c=>{
      let tel=c.telefono;
      if(!tel || !tel.replace(/[^0-9]/g,"")){
        const m=(state.distribucion||[]).find(d=>normN(d.nombre)===normN(c.nombre));
        if(m && m.telefono) tel=m.telefono;
      }
      return {...c, telefono:tel};
    });
    const desdeDistribucion=(state.distribucion||[]).filter(c=>c.fecha_cumple).map(c=>({nombre:c.nombre,telefono:c.telefono,fecha_cumple:c.fecha_cumple}));
    const todos=[...manuales,...desdeDistribucion];
    const hoy=new Date(); hoy.setHours(0,0,0,0);
    const yaNotificado=(state.cumpleNotifs||{});
    const nuevos={...yaNotificado};
    let huboNuevo=false;
    todos.forEach(c=>{
      const md=parseMesDia(c.fecha_cumple); if(!md) return;
      // Fecha del cumple este año
      let fechaCumple=new Date(hoy.getFullYear(),md.mes,md.dia); fechaCumple.setHours(0,0,0,0);
      const diff=Math.round((fechaCumple-hoy)/(1000*60*60*24));
      const claveBase=(c.nombre||"")+"_"+c.fecha_cumple+"_"+hoy.getFullYear();
      // 2 días antes
      if(diff===2){
        const k=claveBase+"_2d";
        if(!nuevos[k]){ notify("cumple",`🎂 Cumpleaños en 2 días: ${c.nombre}`,`Es el ${md.dia} de ${["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"][md.mes]}. Planea el detalle. 🎁`,"🎂 Cumpleaños"); nuevos[k]=true; huboNuevo=true; }
      }
      // El día
      if(diff===0){
        const k=claveBase+"_0d";
        if(!nuevos[k]){ notify("cumple",`🎉 ¡Hoy cumple ${c.nombre}!`,`Felicítalo por WhatsApp, SMS o llamada. 🥳`,"🎂 Cumpleaños"); nuevos[k]=true; huboNuevo=true; }
      }
    });
    if(huboNuevo) setState(s=>({...s,cumpleNotifs:nuevos}));
  },[synced,state.cumpleanos,state.distribucion]);

  const setSection=(section,fn)=>setState(s=>({...s,[section]: typeof fn==="function"?fn(s[section]):fn}));
  const setAppts=fn=>setState(s=>({...s,appts: typeof fn==="function"?fn(s.appts||[]):fn}));
  // ── SINCRONIZACIÓN Agenda → bases de datos ──
  // Cuando una cita de la Agenda se marca como VENTA, la atribuimos a una base:
  // si el teléfono coincide con un cliente existente, le sumamos la venta a su
  // historial; si no existe en ninguna base, creamos una tarjeta en Prospección.
  // El appt queda marcado _sincronizado para que NO se cuente doble (la venta
  // ya vive en el historial del cliente y la estadística sabe de qué base viene).
  const sincronizarVentaAgenda=(appt)=>{
    if(!appt || appt._sincronizado) return;
    setState(s=>{
      const tel=soloNum(appt.telefono||"");
      const monto=Number(appt.monto)||0;
      const histEntry=makeHistorialEntry({ tipo:"cita", cita_resultado:"demo_venta", notas:`💰 Venta agendada en Agenda${appt.producto?` — ${appt.producto}`:""}`, agente:appt.agente||"", monto, producto:appt.producto||"", cartucho_meses:appt.cartucho_meses||0 });
      let grupo=null, encontradoId=null;
      for(const g of ["agregados","prospectos","distribucion"]){
        const arr=s[g]||[];
        const m=tel?arr.find(c=>soloNum(c.telefono||"")===tel):null;
        if(m){ grupo=g; encontradoId=m.id; break; }
      }
      const patch={};
      if(grupo && encontradoId){
        patch[grupo]=(s[grupo]||[]).map(c=>c.id===encontradoId?{...c, venta:true, resultado:"demo_venta", ultimo_monto_venta:monto||c.ultimo_monto_venta, ultimo_producto:appt.producto||c.ultimo_producto, ultimo_cartucho_meses:appt.cartucho_meses||c.ultimo_cartucho_meses, historial:[...(c.historial||[]), histEntry]}:c);
      } else {
        const nuevo={ id:genId(), nombre:appt.nombre||"(Cliente de agenda)", telefono:appt.telefono||"", fuente:"Agenda", producto:appt.producto||"", ciudad:appt.ciudad||"", cp:"", direccion:appt.direccion||"", observaciones:"Venta agendada directo en Agenda", detalles:"", estado:"verde", venta:true, resultado:"demo_venta", ultimo_monto_venta:monto, ultimo_producto:appt.producto||"", ultimo_cartucho_meses:appt.cartucho_meses||0, ultimaNota:"", notas:[], historial:[histEntry], proximo_seguimiento:"", creado:new Date().toISOString(), actualizado:"", _origenAgenda:true };
        grupo="prospectos"; encontradoId=nuevo.id;
        patch.prospectos=[nuevo, ...(s.prospectos||[])];
      }
      patch.appts=(s.appts||[]).map(a=>a.id===appt.id?{...a, _sincronizado:true, _clienteId:encontradoId, _clienteGrupo:grupo}:a);
      return {...s, ...patch};
    });
  };
  const onCallLog=()=>{const today=hoyLocal();const ag=agenteActivo||"Equipo";setState(s=>{const dia=clObj((s.callLog||{})[today]);return {...s,callLog:{...(s.callLog||{}),[today]:{...dia,[ag]:(+dia[ag]||0)+1}}};});};
  // navegación rápida desde el dashboard
  const goTo=(t)=>{ if(!puedeVerTabRol(rolUsuario,t)){ alert("🔒 Tu rol no tiene acceso a esa sección"); return; } setTab(t); setSideOpen(false); };
  const setCofreConfig=(fn)=>setState(s=>({...s, cofreConfig: typeof fn==="function"? fn(s.cofreConfig||{activo:true,niveles:COFRE_NIVELES_DEFAULT.map(n=>({...n,premios:[]}))}) : fn }));
  const abrirCofre=(agente,nivel,premio)=>{
    const semana=lunesDeLaSemana(new Date()).toISOString().slice(0,10);
    setState(s=>{
      const ap=s.cofreAperturas||[];
      if(ap.some(a=>a.agente===agente && a.semana===semana)) return s;
      return {...s, cofreAperturas:[{id:genId(),agente,semana,nivelId:nivel.id,nivelNombre:nivel.nombre,emoji:nivel.emoji,premio,fecha:new Date().toISOString()},...ap]};
    });
  };
  const registrarRespaldo=(mes,tipo)=>{ setState(s=>({...s, respaldos:[{id:genId(),mes,tipo,fecha:new Date().toISOString(),por:agenteActivo},...(s.respaldos||[])]})); };

  // Al tocar una notificación: marcarla leída + ir a la sección correspondiente
  const handleNotifClick=(n)=>{
    marcarUnaLeida(n.id);
    setShowNotifs(false);
    // Mapear la sección de la notificación a una pestaña
    const sec=(n.seccion||"").toLowerCase();
    let destino="inicio";
    if(n.tipo==="resultado") destino="agenda";                    // resultado de cita → Agenda
    else if(sec.includes("agregados")) destino="agregados";
    else if(sec.includes("prospec")) destino="prospectos";
    else if(sec.includes("distribuci")) destino="distribucion";
    else if(sec.includes("referido")) destino="referidos";
    else if(n.tipo==="obsequio") destino="referidos";             // obsequio → Referidos
    else if(n.tipo==="cumple") destino="cumpleanos";              // cumpleaños → Cumpleaños
    else if(n.tipo==="incentivo") destino="inicio";              // incentivo → Inicio (ve su progreso)
    setTab(destino);
  };

  // Memoizado: solo se reconstruye cuando cambian los datos, no en cada render.
  // Sin esto, cada toque recreaba el objeto y rompía la memoización aguas abajo.
  const allData=useMemo(()=>({agregados:state.agregados||[],referidos:state.referidos||[],prospectos:state.prospectos||[],distribucion:state.distribucion||[], appts:state.appts||[]}),
    [state.agregados, state.referidos, state.prospectos, state.distribucion, state.appts]);
  const [importMsg,setImportMsg]=useState("");
  const [dupReview,setDupReview]=useState(null);  // {dest, fresh:[], dups:[]}
  const [refReview,setRefReview]=useState(null);  // referidos a revisar/editar antes de guardar
  const SLABEL = {agregados:"📂 Agregados", prospectos:"🔍 Prospección", distribucion:"🏠 Distribución", referidos:"🎁 Referidos"};

  // Importación masiva (CSV/PDF): los registros ya vienen separados por
  // canal. Se deduplica cada uno contra la base Y contra el propio archivo,
  // y TODO se guarda en una sola actualización de estado — hacerlo en
  // varias seguidas provocaba que una pisara a la otra.
  const guardarImportacionMasiva=(grupos)=>{
    setShowCSV(false);
    const secciones=["agregados","prospectos","distribucion"];
    const vistos=new Set();
    const nuevos={}; let totalNuevos=0, totalDup=0;
    const resumen=[];

    secciones.forEach(sec=>{
      const entrantes=grupos[sec]||[];
      if(!entrantes.length) return;
      const base = sec==="prospectos" ? emptyProspecto : sec==="distribucion" ? emptyDistribucion : emptyClient;
      const frescos=[];
      entrantes.forEach(r0=>{
        const r={ ...base(), ...r0, id:genId(), creado:new Date().toISOString() };
        const kNom=contactKey(r);
        const kCta=normCuenta(r.cuenta);
        const repetidoEnArchivo = vistos.has("n:"+kNom) || (kCta && vistos.has("c:"+kCta));
        const repetidoEnBase = findDuplicate(r, allData);
        if(repetidoEnArchivo || repetidoEnBase){ totalDup++; return; }
        vistos.add("n:"+kNom); if(kCta) vistos.add("c:"+kCta);
        frescos.push(r);
      });
      if(frescos.length){ nuevos[sec]=frescos; totalNuevos+=frescos.length; resumen.push(`${frescos.length} en ${SLABEL[sec]||sec}`); }
    });

    // Referidos: cada anfitrión con su gente. Sin anfitrión indicado, la
    // propia persona encabeza su programa (así no se pierde el registro).
    const refs=grupos.referidos||[];
    let progNuevos=[];
    if(refs.length){
      const porAnfitrion={};
      refs.forEach(r=>{
        const anf=(r._anfitrion||"").trim() || (r.nombre||"").trim();
        if(!porAnfitrion[anf]) porAnfitrion[anf]={ ...emptyReferido(), id:genId(), anfitrion:anf, referidos:[] };
        // Si la fila ES el anfitrión mismo, sus datos van a la cabecera.
        if(!(r._anfitrion||"").trim()){
          porAnfitrion[anf].anfitrion_telefono = porAnfitrion[anf].anfitrion_telefono || r.telefono || "";
          porAnfitrion[anf].anfitrion_ciudad   = porAnfitrion[anf].anfitrion_ciudad   || r.ciudad   || "";
          porAnfitrion[anf].anfitrion_cuenta   = porAnfitrion[anf].anfitrion_cuenta   || r.cuenta   || "";
        } else {
          porAnfitrion[anf].referidos.push({
            nombre:r.nombre||"", telefono:r.telefono||"", direccion:r.direccion||"", ciudad:r.ciudad||"",
            cp:r.cp||"", producto:r.producto||"", observaciones:r.observaciones||"", detalles:r.otrosDetalles||"",
            parentesco:"", estado:"sin_estado", ultimaNota:"", notas:[], historial:[],
            proximo_seguimiento:"", creado:new Date().toISOString(), actualizado:"",
          });
        }
      });
      progNuevos=Object.values(porAnfitrion).filter(p=>p.anfitrion || (p.referidos||[]).length);
      if(progNuevos.length){ totalNuevos+=progNuevos.length; resumen.push(`${progNuevos.length} programa(s) de referidos`); }
    }

    if(!totalNuevos && !totalDup){ setImportMsg("No se importó nada — revisa el mapeo de columnas."); setTimeout(()=>setImportMsg(""),6000); return; }

    // UNA sola actualización con todas las secciones tocadas.
    setState(prev=>{
      const sig={ ...prev };
      Object.keys(nuevos).forEach(sec=>{ sig[sec]=[...nuevos[sec], ...(prev[sec]||[])]; });
      if(progNuevos.length) sig.referidos=[...progNuevos, ...(prev.referidos||[])];
      return sig;
    });

    setImportMsg(`✅ ${totalNuevos} registro(s) importados · ${resumen.join(" · ")}${totalDup?` · ${totalDup} duplicado(s) omitido(s)`:""}`);
    if(totalNuevos) notify("datos", `📂 Importación masiva de ${agenteActivo}`, `${totalNuevos} registro(s) · ${resumen.join(" · ")}`, "Base de datos");
    setTimeout(()=>setImportMsg(""),9000);
  };

  const handleAIExtracted=(records,dest)=>{
    if(dest==="referidos"){ setShowAI(false); setRefReview(records); return; }
    const recs=records.map(r=>({...emptyClient(),...r,id:genId(),creado:new Date().toISOString(),...(dest==="prospectos"?{fuente:r.fuente||"Importado IA"}:{}),...(dest==="distribucion"?{ultima_compra:""}:{})}));
    // Separar nuevos de duplicados (contra la base Y entre ellos mismos)
    const seen=new Set();
    const fresh=[]; const dups=[];
    for(const r of recs){
      const key=contactKey(r);
      const cuentaKey=normCuenta(r.cuenta);
      const dupEntre = seen.has("n:"+key) || (cuentaKey && seen.has("c:"+cuentaKey));
      const dupExistente = findDuplicate(r, allData);
      if(dupEntre || dupExistente){
        dups.push({
          ...r,
          _razon: dupExistente ? dupExistente.motivo : "repetido en este archivo",
          _existente: dupExistente ? dupExistente.match : null,
          _sec: dupExistente ? dupExistente.sec : null,
        });
      } else {
        seen.add("n:"+key); if(cuentaKey) seen.add("c:"+cuentaKey);
        fresh.push(r);
      }
    }
    setShowAI(false);
    if(dups.length>0){
      // Mostrar modal de revisión de duplicados
      setDupReview({dest, fresh, dups});
    } else {
      guardarImportados(dest, fresh, 0);
    }
  };

  // Fusiona un duplicado con su cliente existente en la base
  const fusionarDuplicado=(dup)=>{
    if(!dup._existente || !dup._sec) return;
    const fusionado = fusionarClientes(dup._existente, dup);
    setSection(dup._sec, p=>p.map(x=> x.id===dup._existente.id ? fusionado : x));
  };

  const guardarReferidos=(revisados)=>{
    // Limpiar anfitriones vacíos y referidos vacíos
    const limpios=revisados
      .map(anf=>({...anf, referidos:(anf.referidos||[]).filter(r=>r.nombre?.trim()||r.telefono?.trim())}))
      .filter(anf=>anf.anfitrion?.trim() || (anf.referidos||[]).length>0);
    const totalRefs=limpios.reduce((a,anf)=>a+(anf.referidos||[]).length,0);
    if(limpios.length) setSection("referidos",p=>[...limpios,...p]);
    setImportMsg(`✅ ${limpios.length} anfitrión(es) · ${totalRefs} referido(s) guardado(s)`);
    if(limpios.length){
      notify("datos",
        `🎁 Referidos subidos por ${agenteActivo}`,
        `${limpios.length} anfitrión(es) con ${totalRefs} referido(s) importados`,
        "🎁 Referidos"
      );
    }
    setRefReview(null);
    setTimeout(()=>setImportMsg(""),5000);
  };

  const guardarImportados=(dest, fresh, nDups)=>{
    if(fresh.length) setSection(dest,p=>[...fresh,...p]);
    setImportMsg(`✅ ${fresh.length} agregado(s)${nDups?` · ${nDups} duplicado(s) suprimido(s)`:""}`);
    if(fresh.length) {
      notify("datos",
        `📂 Datos nuevos subidos por ${agenteActivo}`,
        `${fresh.length} registro(s) importados en ${SLABEL[dest]||dest}${nDups?` · ${nDups} duplicado(s) suprimido(s)`:""}`,
        SLABEL[dest]||dest
      );
    }
    setDupReview(null);
    setTimeout(()=>setImportMsg(""),5000);
  };

  const navLabel=NAV.find(n=>n.id===tab);
  const total=allData.agregados.length+allData.referidos.length+allData.prospectos.length+allData.distribucion.length;
  // Badge llamadas: solo clientes SIN ESTADO (pendientes reales por llamar)
  const pendientes=[...allData.prospectos,...allData.agregados,...allData.distribucion].filter(c=>c.estado==="sin_estado").length;
  // Badge agenda: citas agendadas HOY (tipo "cita" en appts con fecha de hoy)
  const hoyNavStr=hoyLocal();
  const citas=(state.appts||[]).filter(a=>a.tipo==="cita" && (a.fecha||"").slice(0,10)===hoyNavStr).length;
  // Memoizado: antes recorría TODO el historial en cada render de la app.
  const conteoHdr=useMemo(()=>conteoLlamadas(allData, state.callLog), [allData, state.callLog]);
  const callsToday=sumDia(conteoHdr[hoyLocal()]);

  // Mientras Firebase confirma si hay sesión, mostramos una pantalla de carga
  if(!authReady){
    return (
      <div className="min-h-screen flex items-center justify-center" style={{background:RP.navyDark}}>
        <div className="text-[#A5A9B0] font-bold text-sm flex items-center gap-2">
          <span className="w-4 h-4 border-2 border-white/20 border-t-[#F4F4F1] rounded-full animate-spin" /> Cargando…
        </div>
      </div>
    );
  }
  // Sin sesión → pantalla de login de Firebase
  if(!authUser){
    return <FirebaseLoginScreen onLogin={iniciarSesion} onReset={recuperarClave} error={loginError} busy={loginBusy} />;
  }
  // Correo autenticado pero no autorizado en esta app
  if(!emailOk){
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{background:RP.navyDark}}>
        <div className="rounded-2xl p-7 shadow-2xl max-w-md w-full text-center" style={{background:RP.navy,border:`1px solid ${RP.silver2}`}}>
          <div className="mb-3 flex justify-center"><Ico e="🔒" size={36} strokeWidth={1.25} className="opacity-40" /></div>
          <div className="text-lg font-extrabold tracking-tight text-[#F4F4F1] mb-2">Cuenta sin acceso</div>
          <div className="text-sm text-[#A5A9B0] mb-5">El correo <strong className="text-[#F4F4F1]">{authUser.email}</strong> no está autorizado en esta app. Pídele acceso a tu administrador.</div>
          <button onClick={cerrarSesion} className="w-full px-4 py-3 rounded-xl text-sm font-bold text-[#FCA5A5] bg-[#F87171]/10 border border-[#F87171]/30 hover:bg-[#F87171]/20 transition">Cerrar sesión</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{background:RP.pageBg,fontFamily:SANS}}>
      {sideOpen && <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={()=>setSideOpen(false)} />}

      {/* SIDEBAR — navy header band like the app */}
      <aside className={`fixed top-0 left-0 h-full w-64 z-50 flex flex-col transition-transform duration-300 ${sideOpen?"translate-x-0":"-translate-x-full"} lg:translate-x-0 bg-[#0B0E12] border-r border-white/10`}>
        <div className="px-5 py-5 border-b border-white/10"><Brand small /></div>
        <div className="flex-1 overflow-y-auto py-3 px-3">
          {NAV.filter(n=>puedeVerTabRol(rolUsuario,n.id) && (n.id!=="incentivo"||puedeGestionarIncentivos)).map(n=>{
            // ── Grupo desplegable "Base de datos" (Agregados, Referidos, Prospección, Distribución) ──
            if(DB_TABS.includes(n.id)){
              if(n.id!==DB_TABS[0]) return null; // las otras 3 se dibujan dentro del grupo
              const dbActivo=DB_TABS.includes(tab);
              const dbAbierto=dbOpen||dbActivo; // si estás dentro de una base, el grupo se ve abierto
              return (
                <div key="grupo-base-datos" className="mb-1">
                  <button onClick={()=>setDbOpen(o=>!o)} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-bold transition ${dbActivo?"text-[#F4F4F1] bg-white/[0.08]":"text-[#A5A9B0] hover:bg-white/[0.05] hover:text-[#F4F4F1]"}`}>
                    <span><Ico e="🗄" /></span>Base de datos
                    <span className="ml-auto flex items-center gap-1.5">
                      <span className="text-xs px-1.5 py-0.5 rounded-full font-bold bg-white/10 text-[#C7CCD1]">{total}</span>
                      <span className={`text-xs transition-transform duration-200 ${dbAbierto?"rotate-180":""}`}>▾</span>
                    </span>
                  </button>
                  {dbAbierto && (
                    <div className="mt-1 ml-3 pl-2 border-l border-white/12 space-y-1">
                      {NAV.filter(x=>DB_TABS.includes(x.id)).map(s=>(
                        <button key={s.id} onClick={()=>{setTab(s.id);setSideOpen(false);}} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-bold transition ${tab===s.id?"text-[#111318] bg-[#F2F1ED]":"text-[#A5A9B0] hover:bg-white/[0.05] hover:text-[#F4F4F1]"}`}><Ico e={s.icon} size={15} />{s.label}</button>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            // ── Items normales del menú ──
            return (<button key={n.id} onClick={()=>{setTab(n.id);setSideOpen(false);}} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-bold mb-1 transition ${tab===n.id?"text-[#111318] bg-[#F2F1ED]":"text-[#A5A9B0] hover:bg-white/[0.05] hover:text-[#F4F4F1]"}`}><Ico e={n.icon} size={16} />{n.label}{n.id==="llamadas"&&pendientes>0&&<span className={`ml-auto text-xs px-1.5 py-0.5 rounded-full font-bold ${tab===n.id?"bg-[#111318] text-[#F2F1ED]":"bg-white/10 text-[#C7CCD1]"}`}>{pendientes}</span>}{n.id==="agenda"&&citas>0&&<span className={`ml-auto text-xs px-1.5 py-0.5 rounded-full font-bold ${tab===n.id?"bg-[#111318] text-[#6EE7B7]":"bg-[#34D399]/15 text-[#6EE7B7]"}`}>{citas}</span>}</button>);
          })}
        </div>
        <div className="px-3 pb-4 border-t border-white/10 pt-3">
          {/* USUARIO ACTIVO — muestra quién inició sesión */}
          <div className="mb-3">
            <div className="text-[10px] font-bold text-[#717680] uppercase tracking-[0.16em] mb-1.5 px-1">Sesión activa</div>
            {/* Toda la tarjeta es un botón: lleva directo a Configuración */}
            <button onClick={()=>{setSideOpen(false);setTab("config");}} className="w-full flex items-center gap-2.5 bg-white/[0.05] border border-white/10 rounded-xl px-3 py-2.5 text-left hover:bg-white/[0.08] active:scale-[0.98] transition">
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-[#111318] font-black text-sm shrink-0 bg-[#F2F1ED]">{(agenteActivo||"T")[0]}</div>
              <div className="flex-1 min-w-0">
                <div className="font-bold text-sm text-[#F4F4F1] truncate">{agenteActivo==="Tomas"?"Tomás Flores":agenteActivo==="Angie"?"Angy Paredes":agenteActivo}</div>
                <div className="text-[10px] text-[#717680] font-bold">{rolUsuario}</div>
              </div>
              <span className="text-[10px] text-[#A5A9B0] font-bold"><Ico e="⚙" /></span>
            </button>
          </div>
          <PrimaryBtn onClick={()=>{setShowAI(true);setSideOpen(false);}} full><Ico e="🤖" className="mr-1.5" />Importar con IA</PrimaryBtn>
          <button onClick={()=>{setShowCSV(true);setSideOpen(false);}} className="w-full mt-2 py-2.5 rounded-xl text-xs font-bold border-2 border-[#e5def4] text-[#5b21b6] active:scale-95 transition"><Ico e="📄" className="mr-1.5" />Importar CSV o PDF (sin IA)</button>
        </div>
      </aside>

      <div className="lg:ml-64 flex flex-col min-h-screen">
        <header className="sticky top-0 z-30 px-4 py-3 flex items-center gap-3 bg-[#0B0E12]/85 backdrop-blur-md border-b border-white/10">
          <button className="lg:hidden w-9 h-9 flex items-center justify-center rounded-lg hover:bg-white/10 text-[#F4F4F1]" onClick={()=>setSideOpen(true)}><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 6h16M4 12h16M4 18h16" /></svg></button>
          <div className="flex items-center gap-2 flex-1 min-w-0"><Ico e={navLabel?.icon} size={18} className="text-[#C7CCD1]" /><span className="font-extrabold text-[#F4F4F1] text-lg truncate tracking-tight" style={{fontFamily:SERIF}}>{navLabel?.label}</span></div>
          <span className="hidden sm:inline-flex items-center gap-1 bg-white/[0.06] border border-white/10 text-[#A5A9B0] text-xs font-bold px-2.5 py-1 rounded-full"><Ico e="📞" className="mr-1.5" />{callsToday} hoy</span>
          {/* Campana de notificaciones */}
          <button onClick={()=>setShowNotifs(p=>!p)} aria-label="Notificaciones"
            className="relative flex items-center justify-center w-9 h-9 rounded-full text-[#F4F4F1] hover:bg-white/10 transition">
            <Ico e="🔔" size={19} />
            {noLeidas>0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-[#F87171] border border-[#0B0E12] text-[#111318] text-[9px] font-black flex items-center justify-center">
                {noLeidas>9?"9+":noLeidas}
              </span>
            )}
          </button>
          <button onClick={()=>setShowAI(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#F2F1ED] text-[#111318] text-xs font-bold hover:brightness-95 transition"><Ico e="🤖" className="mr-1.5" />IA</button>
        </header>
        <main className="flex-1 px-3 py-4 sm:px-5 sm:py-5">
          <div className="max-w-2xl lg:max-w-3xl mx-auto min-h-[70vh]">
            {importMsg && <div className="mb-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-700 font-bold flex items-center justify-between"><Msg>{importMsg}</Msg><button onClick={()=>setImportMsg("")} className="ml-2"><Ico e="✕" /></button></div>}
            {fbError && <div className="mb-4 flex items-start gap-2 bg-red-50 border-2 border-red-300 text-red-700 rounded-xl px-4 py-3 text-sm font-bold">
              <span className="shrink-0"><Ico e="🚨" /></span>
              <span className="flex-1">{sinEmoji(fbError)}</span>
              <button onClick={reintentarFb} className="shrink-0 text-xs px-2 py-1 rounded-lg bg-red-600 text-white">Reintentar ahora</button>
            </div>}
            {tab==="inicio" && <Dashboard allData={allData} appts={state.appts||[]} setAppts={setAppts} callLog={state.callLog} agente={agenteActivo} goTo={goTo} incentivos={state.incentivos||[]} cofreConfig={state.cofreConfig} cofreAperturas={state.cofreAperturas||[]} abrirCofre={abrirCofre} rolActivo={rolUsuario} respaldos={state.respaldos||[]} registrarRespaldo={registrarRespaldo} cumpleanos={state.cumpleanos||[]} />}
            {tab==="agenda" && <Agenda appts={state.appts||[]} setAppts={setAppts} agente={agenteActivo} onVentaSync={sincronizarVentaAgenda} />}
            {tab==="llamadas" && <CallControl data={allData} setData={setSection} onCallLog={onCallLog} role={role} agente={agenteActivo} notify={notify} setAppts={setAppts} rolActivo={rolUsuario} />}
            {tab==="agregados" && <DBSection data={allData.agregados} setData={fn=>setSection("agregados",fn)} type="agregado" title="Clientes Agregados" onCallLog={onCallLog} role={role} allData={allData} agente={agenteActivo} notify={notify} setAppts={setAppts} rolActivo={rolUsuario} />}
            {tab==="referidos" && <DBSection data={allData.referidos} setData={fn=>setSection("referidos",fn)} type="referido" title="Programa Referidos" onCallLog={onCallLog} role={role} allData={allData} agente={agenteActivo} notify={notify} setAppts={setAppts} rolActivo={rolUsuario} />}
            {tab==="prospectos" && <DBSection data={allData.prospectos} setData={fn=>setSection("prospectos",fn)} type="prospecto" title="Prospección" onCallLog={onCallLog} role={role} allData={allData} agente={agenteActivo} notify={notify} setAppts={setAppts} rolActivo={rolUsuario} />}
            {tab==="distribucion" && <DBSection data={allData.distribucion} setData={fn=>setSection("distribucion",fn)} type="distribucion" title="Bajo Distribución" onCallLog={onCallLog} role={role} allData={allData} agente={agenteActivo} notify={notify} setAppts={setAppts} rolActivo={rolUsuario} cobranzaClientes={(state.cobranza||{}).clientesData||{}} />}
            {tab==="reclutamiento" && <RecruitmentSection reclutamiento={state.reclutamiento||[]} setReclutamiento={(fn)=>setState(s=>({...s,reclutamiento:typeof fn==="function"?fn(s.reclutamiento||[]):fn}))} agente={agenteActivo} notify={notify} rolActivo={rolUsuario} setAppts={setAppts} socios={state.socios||[]} setSocios={fn=>setSection("socios",fn)} docsSocios={state.docsSocios||{}} setDocsSocios={fn=>setSection("docsSocios",fn)} />}
            {tab==="cobranza" && <CobranzaSection distribucion={(state.distribucion||[]).filter(c=>!c.eliminado)} cobranza={state.cobranza||{}} setCobranza={(fn)=>setSection("cobranza",fn)} />}
            {tab==="catalogo" && <BuscadorCodigos catalogoCustom={state.catalogoCustom||{}} setCatalogoCustom={(fn)=>setState(st=>({...st,catalogoCustom:typeof fn==="function"?fn(st.catalogoCustom||{}):fn}))} puedeEditar={puedeExportarRol(rolUsuario)} />}
            {tab==="simulador" && <SimuladorCompra />}
            {tab==="rutas" && <RutasSection rutas={state.rutas||[]} setRutas={(fn)=>setState(s=>({...s,rutas:typeof fn==="function"?fn(s.rutas||[]):fn}))} allData={allData} agentes={AGENTES} agente={agenteActivo} notify={notify} />}
            {tab==="servicio" && <ServicioSection appts={state.appts||[]} setAppts={setAppts} agente={agenteActivo} notify={notify} allData={allData} />}
            {tab==="control" && <ControlActividad allData={allData} appts={state.appts||[]} reclutamiento={state.reclutamiento||[]} cierres={state.controlCierres||[]} onGuardarCierre={(c)=>setSection("controlCierres",p=>[c,...(p||[])])} />}
            {tab==="stats" && <Stats data={allData} callLog={state.callLog} appts={state.appts||[]} />}
            {tab==="cumpleanos" && <CumpleSection cumpleanos={state.cumpleanos||[]} setCumple={(fn)=>setState(s=>({...s,cumpleanos:typeof fn==="function"?fn(s.cumpleanos||[]):fn}))} allData={allData} agente={agenteActivo} notify={notify} puedeImportar={true} />}
            {tab==="incentivo" && (puedeGestionarIncentivos
              ? <IncentivosHub incentivos={state.incentivos||[]} setIncentivos={(fn)=>setState(s=>({...s,incentivos:typeof fn==="function"?fn(s.incentivos||[]):fn}))} allData={allData} agentes={AGENTES} notify={notify} rolActivo={rolUsuario} agenteActivo={agenteActivo} cofreConfig={state.cofreConfig} setCofreConfig={setCofreConfig} incentivosCobranza={state.incentivosCobranza||[]} setIncentivosCobranza={(fn)=>setState(s=>({...s,incentivosCobranza:typeof fn==="function"?fn(s.incentivosCobranza||[]):fn}))} incentivosReclut={state.incentivosReclut||[]} setIncentivosReclut={(fn)=>setState(s=>({...s,incentivosReclut:typeof fn==="function"?fn(s.incentivosReclut||[]):fn}))} cobranza={state.cobranza||{}} socios={state.socios||[]} reclutamiento={state.reclutamiento||[]} />
              : <div className="bg-white rounded-2xl p-8 text-center shadow-sm border border-[#e8edf3]"><div className="mb-2 flex justify-center"><Ico e="🔒" size={36} strokeWidth={1.25} className="opacity-40" /></div><div className="text-sm text-slate-500 font-bold">Solo el administrador o distribuidor encargado puede gestionar incentivos.</div><div className="text-xs text-slate-400 mt-1">Tu progreso aparece en tu pantalla de Inicio.</div></div>
            )}
            {tab==="config" && <ConfigSection agenteActivo={agenteActivo} onCerrarSesion={cerrarSesion} rolActivo={rolUsuario} emailActivo={email} cumpleMsgTpl={state.cumpleMsgTpl||""} onSaveCumpleMsg={(t)=>setState(s=>({...s,cumpleMsgTpl:t}))} cuentasCustom={state.cuentasCustom||[]} onSaveCuentas={(u)=>setState(s=>({...s,cuentasCustom:typeof u==="function"?u(s.cuentasCustom||[]):u}))} allData={allData} onLimpiarSinTelefono={()=>{
              const sinTel=(arr)=>(arr||[]).filter(c=>!c.eliminado && soloDigitos(c.telefono).length<10).length;
              const totalSinTel=sinTel(state.agregados)+sinTel(state.prospectos)+sinTel(state.distribucion);
              if(totalSinTel===0){ alert("✅ No hay registros sin teléfono. Todo está limpio."); return; }
              if(!confirm(`Se encontraron ${totalSinTel} registro(s) sin teléfono válido (Agregados, Prospectos y Distribución).\n\n¿Moverlos a la papelera? Podrás restaurarlos si fue un error.`)) return;
              const marcar=(arr)=>(arr||[]).map(c=>(!c.eliminado && soloDigitos(c.telefono).length<10)?{...c,eliminado:true}:c);
              setState(s=>({...s, agregados:marcar(s.agregados), prospectos:marcar(s.prospectos), distribucion:marcar(s.distribucion)}));
              alert(`✅ ${totalSinTel} registro(s) sin teléfono movidos a la papelera.`);
            }} onExtraerCP={()=>{
              // Copia el CP de 5 dígitos que esté dentro de la dirección a la casilla cp (sin tocar la dirección)
              const cuenta=(arr)=>(arr||[]).filter(c=>{
                if(c.eliminado) return false;
                if(String(c.cp||"").replace(/\D/g,"").length===5) return false;
                return zipDesdeTexto(c.direccion||"").length===5;
              }).length;
              const totalCP=cuenta(state.agregados)+cuenta(state.prospectos)+cuenta(state.distribucion);
              if(totalCP===0){ alert("✅ No hay códigos postales por separar. Todo está en orden."); return; }
              if(!confirm(`Se encontraron ${totalCP} cliente(s) con el código postal dentro de la dirección.\n\n¿Copiar ese código postal a su casilla de C.P.? La dirección NO se modifica, solo se llena la casilla vacía.`)) return;
              const arreglar=(arr)=>(arr||[]).map(c=>{
                if(c.eliminado) return c;
                if(String(c.cp||"").replace(/\D/g,"").length===5) return c;
                const zip=zipDesdeTexto(c.direccion||"");
                return zip.length===5 ? {...c, cp:zip} : c;
              });
              setState(s=>({...s, agregados:arreglar(s.agregados), prospectos:arreglar(s.prospectos), distribucion:arreglar(s.distribucion)}));
              alert(`✅ Código postal separado en ${totalCP} cliente(s). Ahora puedes filtrar por C.P. más fácil.`);
            }} />}
          </div>
        </main>
      </div>
      {showAI && <Modal title="🤖 Importar datos con IA" onClose={()=>setShowAI(false)}><AIExtractor onExtracted={handleAIExtracted} onClose={()=>setShowAI(false)} /></Modal>}
      {showCSV && <Modal title="📄 Importar CSV o PDF — sin IA" onClose={()=>setShowCSV(false)}><ImportadorMasivo onListo={guardarImportacionMasiva} onClose={()=>setShowCSV(false)} /></Modal>}
      {refReview && <RefReviewModal records={refReview} onSave={guardarReferidos} onClose={()=>setRefReview(null)} />}
      {dupReview && <Modal title="⚠️ Datos duplicados detectados" onClose={()=>setDupReview(null)}>
        <div className="space-y-4">
          <div className="p-3 rounded-xl bg-amber-50 border border-amber-300 text-sm text-amber-800">
            Se encontraron <strong>{dupReview.dups.length} dato(s) duplicado(s)</strong> que ya existen en tu base (mismo nombre y teléfono, o mismo número de cuenta).
            {dupReview.fresh.length>0 && <> También hay <strong>{dupReview.fresh.length} dato(s) nuevo(s)</strong> listos para guardar.</>}
          </div>

          {dupReview.dups.length>0 && (
            <div>
              <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Duplicados encontrados</div>
              <div className="max-h-48 overflow-y-auto space-y-1.5 bg-[#f4f6f9] rounded-xl p-2">
                {dupReview.dups.map((d,i)=>(
                  <div key={i} className="bg-white rounded-lg px-3 py-2 text-xs border border-[#e8edf3]">
                    <div className="font-bold text-[#1f2d3d]">{d.nombre||"(Sin nombre)"}</div>
                    <div className="text-slate-400">{d.telefono||"Sin tel."}{d.cuenta?` · Cuenta ${d.cuenta}`:""} · <span className="text-amber-600 font-bold">repite {d._razon}</span></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {dupReview.fresh.length>0 && (
            <div>
              <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Nuevos que se guardarán</div>
              <div className="max-h-32 overflow-y-auto space-y-1.5 bg-emerald-50/50 rounded-xl p-2">
                {dupReview.fresh.slice(0,20).map((d,i)=>(
                  <div key={i} className="bg-white rounded-lg px-3 py-2 text-xs border border-emerald-100">
                    <div className="font-bold text-[#1f2d3d]">{d.nombre||"(Sin nombre)"}</div>
                    <div className="text-slate-400">{d.telefono||"Sin tel."}{d.cuenta?` · Cuenta ${d.cuenta}`:""}</div>
                  </div>
                ))}
                {dupReview.fresh.length>20 && <div className="text-center text-xs text-slate-400 py-1">+{dupReview.fresh.length-20} más</div>}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {/* Opción recomendada: fusionar (completa la info de los existentes) + guardar nuevos */}
            <button onClick={()=>{
                const conExistente = dupReview.dups.filter(d=>d._existente);
                conExistente.forEach(d=>fusionarDuplicado(d));
                guardarImportados(dupReview.dest, dupReview.fresh, 0);
                setImportMsg(`✅ ${dupReview.fresh.length} nuevo(s) · ${conExistente.length} completado(s) con info nueva`);
                setTimeout(()=>setImportMsg(""),5000);
              }}
              className="w-full px-4 py-3 rounded-xl text-sm font-bold text-white" style={{background:"#047857"}}>
              🔗 Completar existentes con info nueva{dupReview.fresh.length>0?` + guardar ${dupReview.fresh.length} nuevo(s)`:""}
            </button>
            {dupReview.fresh.length>0 && (
              <button onClick={()=>guardarImportados(dupReview.dest, dupReview.fresh, dupReview.dups.length)}
                className="w-full px-4 py-3 rounded-xl text-sm font-bold text-white" style={{background:RP.navy}}>
                <Ico e="✅" className="mr-1.5" />Solo guardar {dupReview.fresh.length} nuevo(s) (ignorar duplicados)
              </button>
            )}
            <button onClick={()=>setDupReview(null)}
              className="w-full px-4 py-2.5 rounded-xl text-sm font-bold text-slate-500 bg-[#f4f6f9]">
              Cancelar — no guardar nada
            </button>
          </div>
        </div>
      </Modal>}
      {showNotifs && <NotifPanel notifs={notifs} agenteActivo={agenteActivo} onClose={()=>setShowNotifs(false)} onMarcarLeidas={()=>{marcarLeidas();setShowNotifs(false);}} onNotifClick={handleNotifClick} onLimpiar={()=>{ if(confirm("¿Borrar todas las notificaciones? (no afecta clientes ni datos)")){ setState(s=>({...s,notificaciones:[]})); setShowNotifs(false); } }} />}
    </div>
  );
}

// Agente activo (quién usa este dispositivo) — para registrar quién hizo cada acción
function useAgenteActivo() {
  const [a,setA]=useState(()=>{ try { return localStorage.getItem("crm_agente")||"Tomas"; } catch { return "Tomas"; } });
  useEffect(()=>{ try { localStorage.setItem("crm_agente",a); } catch {} },[a]);
  return [a,setA];
}
