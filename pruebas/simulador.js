/**
 * Simulador de Google Apps Script para probar Codigo.gs fuera de Google.
 * Ejecutar:  node pruebas/simulador.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ── Utilities.formatDate con zona horaria real ── */
function partes(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short'
  });
  const o = {};
  f.formatToParts(date).forEach(p => { o[p.type] = p.value; });
  if (o.hour === '24') o.hour = '00';
  const dias = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  o.u = String(dias[o.weekday] || 1);
  return o;
}

function formatDate(date, tz, patron) {
  const p = partes(date, tz);
  return patron
    .replace(/yyyy/g, p.year).replace(/yy/g, p.year.slice(-2))
    .replace(/MM/g, p.month).replace(/dd/g, p.day)
    .replace(/HH/g, p.hour).replace(/mm/g, p.minute).replace(/ss/g, p.second)
    .replace(/\bu\b/g, p.u);
}

/* ── Hoja de cálculo falsa ── */
const noop = new Proxy(function () {}, {
  get: () => noop,
  apply: () => noop
});

class Hoja {
  constructor(nombre) { this.nombre = nombre; this.datos = []; }
  getName() { return this.nombre; }
  setName(n) { this.nombre = n; return this; }
  getLastRow() { return this.datos.length; }
  getLastColumn() { return this.datos.length ? Math.max(...this.datos.map(f => f.length)) : 0; }
  _asegurar(fila, col) {
    while (this.datos.length < fila) this.datos.push([]);
    for (const f of this.datos) while (f.length < col) f.push('');
  }
  getDataRange() { return this.getRange(1, 1, Math.max(this.datos.length, 1), Math.max(this.getLastColumn(), 1)); }
  getRange(a, b, c, d) {
    if (typeof a === 'string') return rangoFalso();
    const hoja = this;
    const r0 = a, c0 = b, nr = c || 1, nc = d || 1;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const fila = hoja.datos[r0 - 1 + i] || [];
          const f = [];
          for (let j = 0; j < nc; j++) f.push(fila[c0 - 1 + j] === undefined ? '' : fila[c0 - 1 + j]);
          out.push(f);
        }
        return out;
      },
      getValue() { return this.getValues()[0][0]; },
      setValues(v) {
        hoja._asegurar(r0 - 1 + v.length, c0 - 1 + v[0].length);
        v.forEach((fila, i) => fila.forEach((val, j) => { hoja.datos[r0 - 1 + i][c0 - 1 + j] = val; }));
        return this;
      },
      setValue(v) { return this.setValues([[v]]); },
      setNumberFormat() { return this; },
      setFontWeight() { return this; },
      setBackground() { return this; },
      setFontColor() { return this; }
    };
  }
  appendRow(fila) { this.datos.push(fila.slice()); return this; }
  clear() { this.datos = []; return this; }
  deleteRows(desde, cuantas) { this.datos.splice(desde - 1, cuantas); return this; }
  setFrozenRows() { return this; }
  hideColumns() { return this; }
}

function rangoFalso() {
  return { setNumberFormat: () => rangoFalso(), setFontWeight: () => rangoFalso(),
           setBackground: () => rangoFalso(), setFontColor: () => rangoFalso(),
           getValues: () => [[]], setValues: () => rangoFalso(), setValue: () => rangoFalso() };
}

class Libro {
  constructor() { this.hojas = []; }
  getSheetByName(n) { return this.hojas.find(h => h.nombre === n) || null; }
  insertSheet(n) { const h = new Hoja(n); this.hojas.push(h); return h; }
  setSpreadsheetTimeZone() { return this; }
}

/* ── Entorno global ── */
const libro = new Libro();
let RELOJ = new Date();

const sandbox = {
  console,
  Date: class extends Date {
    constructor(...args) { if (args.length === 0) super(RELOJ.getTime()); else super(...args); }
    static now() { return RELOJ.getTime(); }
  },
  Math, JSON, String, Number, Object, Array, isNaN, parseInt, parseFloat, Intl,
  SpreadsheetApp: {
    getActiveSpreadsheet: () => libro,
    getUi: () => ({ createMenu: () => noop, alert: () => {}, ButtonSet: { OK: 1 } })
  },
  Utilities: { formatDate },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  ContentService: { createTextOutput: (t) => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => noop, deleteTrigger: () => {} }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Codigo.gs'), 'utf8'), sandbox);

/* ── Helpers de prueba ── */
function reloj(iso) { RELOJ = new Date(iso); }           // hora de Bogotá = UTC-5
function llamar(p) { return JSON.parse(sandbox.manejar_(p)); }

let ok = 0, fallo = 0;
function verificar(titulo, condicion, detalle) {
  if (condicion) { ok++; console.log('  ✅ ' + titulo); }
  else { fallo++; console.log('  ❌ ' + titulo + (detalle ? '  →  ' + detalle : '')); }
}

/* ═══════════════ ESCENARIOS ═══════════════ */
console.log('\n══════ PRUEBAS DEL CONTROL DE ASISTENCIA ══════\n');

reloj('2026-08-31T12:00:00Z');
sandbox.instalar();
console.log('1) Instalación');
['Empleados','Registros','Resumen_Diario','Resumen_Semanal','Resumen_Mensual','Inconsistencias','Config','Auditoria']
  .forEach(n => verificar('Hoja "' + n + '" creada', !!libro.getSheetByName(n)));

// Empleados de prueba (rostro simulado con 3 números)
const emp = libro.getSheetByName('Empleados');
emp.appendRow(['E1', 'Ana Pérez',  '111', 'Centro', 'SI', 1, '[[0.1,0.1,0.1]]', new Date(), new Date()]);
emp.appendRow(['E2', 'Luis Gómez', '222', 'Centro', 'SI', 1, '[[0.9,0.9,0.9]]', new Date(), new Date()]);
// GPS exacto de la sede Centro
const GPS = { lat: 6.2518, lng: -75.5636 };

console.log('\n2) Una sola ENTRADA por día');
reloj('2026-08-31T13:00:00Z'); // lunes 08:00 Bogotá
let r = llamar({ action: 'checkIn', empleadoId: 'E1', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('Primera entrada aceptada', r.success, r.message);

reloj('2026-08-31T13:00:03Z'); // doble toque 3 segundos después
r = llamar({ action: 'checkIn', empleadoId: 'E1', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('Segunda entrada RECHAZADA', !r.success && r.code === 'YA_ENTRO', r.message);

reloj('2026-08-31T15:30:00Z');
r = llamar({ action: 'checkIn', empleadoId: 'E1', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('Entrada 2 horas después también RECHAZADA', !r.success, r.message);

console.log('\n3) Una sola SALIDA + descuento de almuerzo');
reloj('2026-08-31T13:01:00Z');
r = llamar({ action: 'checkOut', empleadoId: 'E1', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('Salida al minuto RECHAZADA (mínimo 5 min)', !r.success && r.code === 'MUY_PRONTO', r.message);

reloj('2026-08-31T22:00:00Z'); // 17:00 Bogotá → 9 h brutas
r = llamar({ action: 'checkOut', empleadoId: 'E1', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('Salida aceptada', r.success, r.message);
verificar('9 h brutas', r.registro && r.registro.brutas === 9, JSON.stringify(r.registro));
verificar('Descuenta 1 h de almuerzo', r.registro && r.registro.descuento === 1);
verificar('8 h netas', r.registro && r.registro.horas === 8);

reloj('2026-08-31T22:00:05Z');
r = llamar({ action: 'checkOut', empleadoId: 'E1', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('Segunda salida RECHAZADA', !r.success && r.code === 'YA_SALIO', r.message);

reloj('2026-08-31T23:00:00Z');
r = llamar({ action: 'checkIn', empleadoId: 'E1', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('No deja volver a entrar el mismo día', !r.success, r.message);

console.log('\n4) Jornada corta: sin descuento de almuerzo');
reloj('2026-09-01T13:00:00Z'); // martes 08:00
llamar({ action: 'checkIn', empleadoId: 'E2', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
reloj('2026-09-01T18:00:00Z'); // 13:00 → 5 h
r = llamar({ action: 'checkOut', empleadoId: 'E2', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('5 h sin descuento', r.success && r.registro.descuento === 0 && r.registro.horas === 5, JSON.stringify(r.registro));

console.log('\n5) Turno nocturno (cruza medianoche)');
emp.appendRow(['E3', 'Sara Ruiz', '333', 'Centro', 'SI', 1, '[[0.5,0.5,0.5]]', new Date(), new Date()]);

reloj('2026-09-03T03:00:00Z'); // miércoles 2 sep, 22:00 Bogotá
r = llamar({ action: 'checkIn', empleadoId: 'E3', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('Entrada nocturna 2-sep 22:00 aceptada', r.success, r.message);

reloj('2026-09-03T04:00:00Z'); // 23:00 del mismo 2 sep
r = llamar({ action: 'checkIn', empleadoId: 'E3', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('Segunda entrada dentro del turno RECHAZADA', !r.success && r.code === 'YA_ENTRO', r.message);

reloj('2026-09-03T11:00:00Z'); // jueves 3 sep, 06:00 Bogotá
r = llamar({ action: 'checkOut', empleadoId: 'E3', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('Salida a las 06:00 del día siguiente aceptada', r.success, r.message);
verificar('Horas contadas al día de la ENTRADA (2026-09-02)', r.registro.fecha === '2026-09-02', r.registro.fecha);
verificar('8 h brutas → 7 h netas', r.registro.brutas === 8 && r.registro.horas === 7, JSON.stringify(r.registro));

reloj('2026-09-03T13:00:00Z'); // jueves 3 sep, 08:00 — el mismo día en que SALIÓ
r = llamar({ action: 'checkIn', empleadoId: 'E3', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('Puede iniciar una jornada nueva el 3-sep', r.success, r.message);
reloj('2026-09-03T19:00:00Z'); // 14:00
r = llamar({ action: 'checkOut', empleadoId: 'E3', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('Cierra la jornada del 3-sep', r.success && r.registro.fecha === '2026-09-03', JSON.stringify(r.registro));

console.log('\n6) Salida olvidada → PENDIENTE');
reloj('2026-09-04T13:00:00Z'); // viernes 08:00
llamar({ action: 'checkIn', empleadoId: 'E1', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
reloj('2026-09-07T13:00:00Z'); // lunes siguiente 08:00, nunca marcó salida
const n = sandbox.cerrarJornadasOlvidadas();
verificar('Cierre automático marcó 1 jornada', n === 1, 'cerradas: ' + n);
r = llamar({ action: 'checkIn', empleadoId: 'E1', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
verificar('Puede entrar el lunes pese al olvido del viernes', r.success, r.message);
const incons = libro.getSheetByName('Inconsistencias');
verificar('Aparece en la hoja Inconsistencias', incons.datos.length >= 2, 'filas: ' + incons.datos.length);

console.log('\n7) Control de ubicación (GPS)');
r = llamar({ action: 'checkIn', empleadoId: 'E2', sede: 'Centro', lat: 6.30, lng: -75.60 });
verificar('Rechaza marcación lejos de la sede', !r.success && r.code === 'GPS', r.message);
r = llamar({ action: 'checkIn', empleadoId: 'E2', sede: 'Sede Inventada', lat: GPS.lat, lng: GPS.lng });
verificar('Rechaza sede inexistente', !r.success, r.message);

console.log('\n8) Resúmenes semanal y mensual');
reloj('2026-09-07T20:00:00Z');
llamar({ action: 'checkOut', empleadoId: 'E1', sede: 'Centro', lat: GPS.lat, lng: GPS.lng });
sandbox.recalcularResumenes();
const sem = libro.getSheetByName('Resumen_Semanal');
const mes = libro.getSheetByName('Resumen_Mensual');
verificar('Resumen_Semanal tiene filas', sem.datos.length > 1, 'filas: ' + sem.datos.length);
verificar('Resumen_Mensual tiene filas', mes.datos.length > 1, 'filas: ' + mes.datos.length);

const semAna = sem.datos.slice(1).filter(f => f[4] === 'Ana Pérez');
const totalAna = semAna.reduce((a, f) => a + Number(f[6]), 0);
verificar('Horas de Ana repartidas en varias semanas', semAna.length >= 2, 'semanas: ' + semAna.length);
verificar('Total de Ana coherente (> 0)', totalAna > 0, 'total: ' + totalAna);

const mesAgo = mes.datos.slice(1).find(f => f[0] === '2026-08' && f[2] === 'Ana Pérez');
verificar('Agosto de Ana = 8 h netas', mesAgo && Number(mesAgo[4]) === 8, JSON.stringify(mesAgo));

console.log('\n9) Reporte que consume la app');
reloj('2026-09-07T21:00:00Z');
r = llamar({ action: 'getReports' });
verificar('getReports responde', r.success);
verificar('Semana en curso identificada', /^\d{4}-S\d{2}$/.test(r.semana.clave), r.semana.clave);

r = llamar({ action: 'getTodayRecord', empleadoId: 'E1' });
verificar('getTodayRecord marca la jornada de hoy como completa',
  r.success && r.registro && r.registro.estado === 'COMPLETO', JSON.stringify(r.registro));
verificar('No permite entrar de nuevo hoy', r.puedeEntrar === false);
verificar('No permite salir de nuevo hoy', r.puedeSalir === false);

console.log('\n10) Semana ISO');
verificar('2026-08-31 (lunes) → semana empieza ese día', sandbox.semanaIso_('2026-08-31').desde === '2026-08-31');
verificar('2026-09-06 (domingo) → misma semana', sandbox.semanaIso_('2026-09-06').clave === sandbox.semanaIso_('2026-08-31').clave);
verificar('2026-09-07 (lunes) → semana siguiente', sandbox.semanaIso_('2026-09-07').clave !== sandbox.semanaIso_('2026-09-06').clave);

console.log('\n══════════════════════════════════════════════');
console.log(ok + ' pruebas OK · ' + fallo + ' fallidas');
console.log('══════════════════════════════════════════════\n');
if (fallo) process.exit(1);
