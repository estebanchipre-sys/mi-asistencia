/**
 * ============================================================================
 *  CONTROL DE ASISTENCIA — BACKEND (Google Apps Script)
 *  Base de datos: Google Sheets
 *  Zona horaria: America/Bogota
 * ----------------------------------------------------------------------------
 *  REGLAS DE NEGOCIO
 *   1. Una (1) sola ENTRADA por empleado por día.
 *   2. Una (1) sola SALIDA por empleado por jornada.
 *   3. Turnos nocturnos permitidos: la salida puede caer en la madrugada del
 *      día siguiente; las horas se acumulan al DÍA DE LA ENTRADA.
 *   4. Si no marcan salida, la jornada queda en estado PENDIENTE (0 horas) y
 *      aparece en la hoja "Inconsistencias" para corrección manual.
 *   5. Se descuenta 1 hora de almuerzo en jornadas mayores a 6 horas.
 *   6. Todas las escrituras usan LockService: dos toques seguidos NO crean
 *      dos registros.
 * ----------------------------------------------------------------------------
 *  INSTALACIÓN: ver INSTALACION.md
 * ============================================================================
 */

/* ─────────────────────────  CONSTANTES  ───────────────────────── */

var TZ = 'America/Bogota';
var VERSION = '2.0.0';

var HOJAS = {
  EMPLEADOS:       'Empleados',
  REGISTROS:       'Registros',
  DIARIO:          'Resumen_Diario',
  SEMANAL:         'Resumen_Semanal',
  MENSUAL:         'Resumen_Mensual',
  INCONSISTENCIAS: 'Inconsistencias',
  CONFIG:          'Config',
  AUDITORIA:       'Auditoria'
};

var H_EMPLEADOS = ['ID', 'Nombre', 'Documento', 'Sede_Principal', 'Activo',
                   'Muestras_Rostro', 'Descriptores', 'Fecha_Registro', 'Actualizado'];

var H_REGISTROS = ['ID_Registro', 'ID_Empleado', 'Nombre', 'Fecha', 'Dia',
                   'Entrada', 'Salida', 'Horas_Brutas', 'Descuento', 'Horas_Netas',
                   'Sede_Entrada', 'Sede_Salida', 'GPS_Entrada', 'GPS_Salida',
                   'Estado', 'Semana', 'Mes', 'Observaciones'];

var H_DIARIO = ['Fecha', 'Dia', 'ID_Empleado', 'Nombre', 'Sede',
                'Entrada', 'Salida', 'Horas_Netas', 'Horas_HHMM', 'Estado'];

var H_SEMANAL = ['Semana', 'Desde', 'Hasta', 'ID_Empleado', 'Nombre',
                 'Dias_Trabajados', 'Horas_Netas', 'Horas_HHMM',
                 'Promedio_Dia', 'Dias_Pendientes'];

var H_MENSUAL = ['Mes', 'ID_Empleado', 'Nombre', 'Dias_Trabajados',
                 'Horas_Netas', 'Horas_HHMM', 'Promedio_Dia', 'Dias_Pendientes'];

var H_INCONSISTENCIAS = ['Fecha', 'ID_Empleado', 'Nombre', 'Entrada', 'Salida',
                         'Estado', 'Problema', 'ID_Registro'];

var H_CONFIG = ['Clave', 'Valor', 'Descripcion'];

var H_AUDITORIA = ['Timestamp', 'Accion', 'ID_Empleado', 'Nombre', 'Resultado', 'Detalle'];

/**
 * SEDES — única fuente de verdad. La app las lee de aquí, así no hay que
 * tocar el HTML para agregar o corregir una sede.
 *
 * "verificada: true"  = la coordenada se calculó con el GPS de las marcaciones reales.
 * "verificada: false" = coordenada estimada, NADIE ha marcado nunca ahí todavía.
 *
 * Para corregir una: menú ⏱ Asistencia → "Sugerir coordenadas reales de sedes".
 * Esa opción promedia el GPS de las marcaciones ya guardadas y te dice el punto exacto.
 */
var SEDES = [
  // Verificada con 17 marcaciones reales (dispersión de solo 34 m).
  // La coordenada anterior (6.2142, -75.5913) estaba a ~600 m del local:
  // con un radio de 250 m NADIE habría podido marcar.
  { nombre: 'Guayabal - Julián',    corto: 'Guayabal',      detalle: 'Julián · Cl. 5A #58-4',  lat: 6.212850, lng: -75.585934, verificada: true },

  // Sin marcaciones todavía: verifica estas antes de usarlas.
  { nombre: 'Guayabal - Vampi',     corto: 'Guayabal',      detalle: 'Vampi · Cl. 17A #54-99', lat: 6.213800, lng: -75.591000, verificada: false },
  { nombre: 'Laboratorio Robleado', corto: 'Lab. Robleado', detalle: 'Cl. 80A #72C-180',       lat: 6.272300, lng: -75.608300, verificada: false },
  { nombre: 'Laboratorio Caribe',   corto: 'Lab. Caribe',   detalle: 'Cl. 75A #64D-17',        lat: 6.270000, lng: -75.607000, verificada: false },
  { nombre: 'Centro',               corto: 'Centro',        detalle: 'Cra. 51 #45-70',         lat: 6.251800, lng: -75.563600, verificada: false },
  { nombre: 'Laboratorio Itagüí',   corto: 'Lab. Itagüí',   detalle: 'Cra. 52A #45-11',        lat: 6.184900, lng: -75.599000, verificada: false }
];

/** Colombia es UTC-5 todo el año (no hay horario de verano). */
var OFFSET_BOGOTA = 5;

/** Nombres de las hojas del sistema anterior, para importarlas sin tocarlas. */
var LEGACY_EMPLEADOS = 'Employees';
var LEGACY_REGISTROS = 'Records';

var CONFIG_DEFAULT = [
  ['PIN_ADMIN',              '1234', 'PIN para registrar empleados nuevos o agregar rostros. CÁMBIALO YA.'],
  ['DESCUENTO_ALMUERZO_MIN', '60',   'Minutos que se descuentan por almuerzo en jornadas largas.'],
  ['UMBRAL_DESCUENTO_HORAS', '6',    'A partir de cuántas horas brutas se aplica el descuento.'],
  ['MAX_HORAS_JORNADA',      '16',   'Más de esto se marca como ANOMALIA (posible olvido).'],
  ['MIN_MINUTOS_JORNADA',    '5',    'Mínimo de minutos entre entrada y salida.'],
  ['PERMITIR_TURNO_NOCTURNO','SI',   'SI = la salida puede caer al día siguiente.'],
  ['EXIGIR_GPS',             'SI',   'SI = no deja marcar fuera del radio de la sede.'],
  ['RADIO_GEO_METROS',       '250',  'Radio permitido alrededor de la sede, en metros.'],
  ['UMBRAL_ROSTRO',          '0.45', 'Menor = más estricto el reconocimiento facial.'],
  ['DIAS_HISTORIAL',         '30',   'Días de historial que devuelve la app.'],
  ['INICIO_SEMANA',          'LUNES','Día en que arranca la semana laboral.']
];

/* ─────────────────────────  UTILIDADES  ───────────────────────── */

/**
 * ID de la hoja de cálculo (lo que va entre /d/ y /edit en la URL).
 *
 * · Si este proyecto está VINCULADO a la hoja (Extensiones → Apps Script),
 *   puedes dejarlo vacío: ''.
 * · Si es un proyecto INDEPENDIENTE (script.google.com), déjalo con el ID.
 *
 * Se deja puesto porque el script que estaba vinculado a la hoja se perdió,
 * y por eso la URL /exec anterior respondía 404.
 */
var ID_HOJA = '1ogbq3c4jInMVKPp_k0yOTeiXb12Bk_uWpdAJt05Z-vk';

function ss_() {
  if (ID_HOJA) return SpreadsheetApp.openById(ID_HOJA);
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** Devuelve la interfaz de la hoja, o null si el script corre sin ventana abierta. */
function ui_() {
  try { return SpreadsheetApp.getUi(); } catch (e) { return null; }
}

function hoja_(nombre) {
  var s = ss_().getSheetByName(nombre);
  if (!s) { instalar(); s = ss_().getSheetByName(nombre); }
  return s;
}

function fmt_(fecha, patron) {
  return Utilities.formatDate(fecha, TZ, patron);
}

/** 'yyyy-MM-dd' de una fecha o de un valor de celda. */
function claveFecha_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return fmt_(v, 'yyyy-MM-dd');
  return String(v).trim().substring(0, 10);
}

function ahora_() { return new Date(); }

/**
 * Instante exacto de la medianoche local (Bogotá) del día al que pertenece `d`.
 * No usa `new Date('yyyy/MM/dd')` porque eso se interpreta en la zona horaria
 * del servidor y desplazaba la fecha un día. Colombia no tiene horario de verano.
 */
function fechaDiaLocal_(d) {
  var h = Number(fmt_(d, 'HH'));
  var m = Number(fmt_(d, 'mm'));
  var s = Number(fmt_(d, 'ss'));
  var base = new Date(d.getTime() - (h * 3600 + m * 60 + s) * 1000);
  return new Date(base.getTime() - base.getMilliseconds());
}

var DIAS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function nombreDia_(fecha) {
  return DIAS_ES[Number(fmt_(fecha, 'u')) % 7];
}

function isoUTC_(d) {
  return d.getUTCFullYear() + '-' +
         ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' +
         ('0' + d.getUTCDate()).slice(-2);
}

/**
 * Semana ISO (arranca lunes) a prueba de zonas horarias: todo el cálculo se
 * hace en UTC sobre la clave 'yyyy-MM-dd'.
 * Devuelve {clave:'2026-S36', desde:'2026-08-31', hasta:'2026-09-06'}
 */
function semanaIso_(fecha) {
  var clave = claveFecha_(fecha) || fmt_(new Date(), 'yyyy-MM-dd');
  var p = clave.split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  var diaSem = (d.getUTCDay() + 6) % 7;                    // 0 = lunes
  var lunes   = new Date(d.getTime() - diaSem * 86400000);
  var domingo = new Date(lunes.getTime() + 6 * 86400000);
  var jueves  = new Date(lunes.getTime() + 3 * 86400000);   // el jueves define el año ISO
  var enero1  = new Date(Date.UTC(jueves.getUTCFullYear(), 0, 1));
  var semana  = Math.ceil((((jueves - enero1) / 86400000) + 1) / 7);
  return {
    clave: jueves.getUTCFullYear() + '-S' + ('0' + semana).slice(-2),
    desde: isoUTC_(lunes),
    hasta: isoUTC_(domingo)
  };
}

/** Muestra una hora venga como Date (sistema nuevo) o como texto (datos migrados). */
function horaTexto_(v, patron) {
  if (!v && v !== 0) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return fmt_(v, patron || 'HH:mm:ss');
  var t = String(v).trim();
  return t === 'Invalid Date' ? '' : t;
}

function horasAHHMM_(horas) {
  var n = Number(horas) || 0;
  if (n < 0) n = 0;
  var h = Math.floor(n);
  var m = Math.round((n - h) * 60);
  if (m === 60) { h += 1; m = 0; }
  return h + 'h ' + ('0' + m).slice(-2) + 'm';
}

function redondear_(n, dec) {
  var f = Math.pow(10, dec || 2);
  return Math.round((Number(n) || 0) * f) / f;
}

var ACENTOS = { 'á':'a','à':'a','ä':'a','â':'a','é':'e','è':'e','ë':'e','ê':'e',
                'í':'i','ì':'i','ï':'i','î':'i','ó':'o','ò':'o','ö':'o','ô':'o',
                'ú':'u','ù':'u','ü':'u','û':'u','ñ':'n','ç':'c' };

function normalizar_(t) {
  var s = String(t === null || t === undefined ? '' : t).toLowerCase();
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    c = ACENTOS[c] || c;
    if (c >= 'a' && c <= 'z') out += c;
    else if (c >= '0' && c <= '9') out += c;
  }
  return out;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ─────────────────────────  CONFIG  ───────────────────────── */

function leerConfig() {
  var s = hoja_(HOJAS.CONFIG);
  var v = s.getDataRange().getValues();
  var c = {};
  for (var i = 1; i < v.length; i++) {
    if (v[i][0]) c[String(v[i][0]).trim()] = String(v[i][1]).trim();
  }
  CONFIG_DEFAULT.forEach(function (d) { if (c[d[0]] === undefined) c[d[0]] = d[1]; });
  return c;
}

function cfgNum_(c, k) { return Number(c[k]); }
function cfgSi_(c, k)  { return String(c[k] || '').toUpperCase() === 'SI'; }

/* ─────────────────────────  INSTALACIÓN / REPARACIÓN  ───────────────────────── */

/**
 * Crea o repara todas las hojas. NO borra nada:
 * si encuentra una hoja con estructura vieja, la renombra a RESPALDO_… y
 * trata de migrar sus datos por nombre de columna.
 */
function instalar() {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  libro.setSpreadsheetTimeZone(TZ);
  var sello = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmmss');
  var informe = [];

  informe = informe.concat(prepararHoja_(libro, HOJAS.EMPLEADOS, H_EMPLEADOS, sello));
  informe = informe.concat(prepararHoja_(libro, HOJAS.REGISTROS, H_REGISTROS, sello));
  prepararHoja_(libro, HOJAS.DIARIO, H_DIARIO, sello, true);
  prepararHoja_(libro, HOJAS.SEMANAL, H_SEMANAL, sello, true);
  prepararHoja_(libro, HOJAS.MENSUAL, H_MENSUAL, sello, true);
  prepararHoja_(libro, HOJAS.INCONSISTENCIAS, H_INCONSISTENCIAS, sello, true);
  prepararHoja_(libro, HOJAS.AUDITORIA, H_AUDITORIA, sello, true);

  // Config
  var cfg = libro.getSheetByName(HOJAS.CONFIG);
  if (!cfg) {
    cfg = libro.insertSheet(HOJAS.CONFIG);
    cfg.getRange(1, 1, 1, H_CONFIG.length).setValues([H_CONFIG]);
    cfg.getRange(2, 1, CONFIG_DEFAULT.length, 3).setValues(CONFIG_DEFAULT);
    informe.push('Se creó la hoja Config con los valores por defecto.');
  } else {
    var existentes = {};
    var vc = cfg.getDataRange().getValues();
    for (var i = 1; i < vc.length; i++) if (vc[i][0]) existentes[String(vc[i][0]).trim()] = true;
    var faltantes = CONFIG_DEFAULT.filter(function (d) { return !existentes[d[0]]; });
    if (faltantes.length) {
      cfg.getRange(cfg.getLastRow() + 1, 1, faltantes.length, 3).setValues(faltantes);
      informe.push('Se agregaron ' + faltantes.length + ' parámetros nuevos a Config.');
    }
  }

  informe = informe.concat(importarSistemaAnterior_());

  var normalizadas = normalizarRegistros_();
  if (normalizadas) informe.push('Se completaron los datos faltantes de ' + normalizadas + ' registro(s) antiguo(s) para que cuenten en los resúmenes.');

  aplicarFormato_(libro);
  recalcularResumenes();

  informe.push('Sistema instalado / reparado correctamente (v' + VERSION + ').');
  return informe;
}

function prepararHoja_(libro, nombre, headers, sello, esDerivada) {
  var informe = [];
  var s = libro.getSheetByName(nombre);

  if (!s) {
    s = libro.insertSheet(nombre);
    s.getRange(1, 1, 1, headers.length).setValues([headers]);
    informe.push('Se creó la hoja "' + nombre + '".');
    return informe;
  }

  var actuales = s.getLastColumn() > 0
    ? s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0].map(String)
    : [];

  var coincide = headers.length === actuales.length &&
                 headers.every(function (h, i) { return normalizar_(h) === normalizar_(actuales[i]); });

  if (coincide) return informe;

  // Hojas derivadas: se reconstruyen solas, se pueden limpiar sin perder nada.
  if (esDerivada) {
    s.clear();
    s.getRange(1, 1, 1, headers.length).setValues([headers]);
    informe.push('Se reconstruyó la hoja derivada "' + nombre + '".');
    return informe;
  }

  // Hojas con datos reales: respaldar y migrar.
  var datosViejos = s.getDataRange().getValues();
  var respaldo = 'RESPALDO_' + nombre + '_' + sello;
  s.setName(respaldo);
  informe.push('La hoja "' + nombre + '" tenía otra estructura: se conservó completa como "' + respaldo + '".');

  var nueva = libro.insertSheet(nombre);
  nueva.getRange(1, 1, 1, headers.length).setValues([headers]);

  var migradas = migrar_(nueva, headers, datosViejos);
  if (migradas > 0) informe.push('Se migraron ' + migradas + ' filas desde el respaldo a "' + nombre + '".');
  else informe.push('No se pudo mapear automáticamente el respaldo de "' + nombre + '" (revísalo a mano).');

  return informe;
}

/** Migra filas viejas emparejando encabezados por nombre normalizado + sinónimos. */
function migrar_(hojaNueva, headers, datosViejos) {
  if (!datosViejos || datosViejos.length < 2) return 0;

  var SINONIMOS = {
    id: ['id', 'idempleado', 'codigo', 'employeeid'],
    nombre: ['nombre', 'empleado', 'name', 'employeename', 'nombrecompleto'],
    documento: ['documento', 'cedula', 'cc', 'identificacion'],
    sedeprincipal: ['sedeprincipal', 'sede', 'sucursal', 'ubicacion'],
    activo: ['activo', 'estado', 'active'],
    descriptores: ['descriptores', 'descriptor', 'facedescriptor', 'rostro', 'descriptorfacial'],
    idempleado: ['idempleado', 'employeeid', 'id'],
    fecha: ['fecha', 'date', 'dia'],
    entrada: ['entrada', 'checkin', 'horaentrada', 'ingreso'],
    salida: ['salida', 'checkout', 'horasalida', 'egreso'],
    horasnetas: ['horasnetas', 'horas', 'hoursworked', 'horaslaboradas', 'horastrabajadas'],
    sedeentrada: ['sedeentrada', 'sede', 'sucursal'],
    observaciones: ['observaciones', 'nota', 'notas', 'comentario']
  };

  var viejos = datosViejos[0].map(function (h) { return normalizar_(h); });
  var mapa = [];
  var alguno = false;

  headers.forEach(function (h) {
    var clave = normalizar_(h);
    var candidatos = SINONIMOS[clave] || [clave];
    var idx = -1;
    for (var c = 0; c < candidatos.length && idx < 0; c++) idx = viejos.indexOf(candidatos[c]);
    mapa.push(idx);
    if (idx >= 0) alguno = true;
  });

  if (!alguno) return 0;

  var filas = [];
  for (var i = 1; i < datosViejos.length; i++) {
    var fila = mapa.map(function (idx) { return idx >= 0 ? datosViejos[i][idx] : ''; });
    if (fila.join('').trim() !== '') filas.push(fila);
  }
  if (!filas.length) return 0;

  hojaNueva.getRange(2, 1, filas.length, headers.length).setValues(filas);
  return filas.length;
}

/* ───────────────  IMPORTAR EL SISTEMA ANTERIOR (Employees / Records)  ─────────────── */

/** Busca en qué columna está cada campo, aceptando varios nombres posibles. */
function indices_(cabecera, mapa) {
  var norm = cabecera.map(function (h) { return normalizar_(h); });
  var out = {};
  Object.keys(mapa).forEach(function (clave) {
    out[clave] = -1;
    mapa[clave].forEach(function (nombre) {
      if (out[clave] < 0) out[clave] = norm.indexOf(normalizar_(nombre));
    });
  });
  return out;
}

/** Combina '2026-08-10' + '12:32:42' en un Date real de la hora de Bogotá. */
function fechaHoraLocal_(fechaStr, horaStr) {
  var f = claveFecha_(fechaStr);
  if (!f || f.length < 10) return null;
  var p = f.split('-');
  var h = String(horaStr || '00:00:00').trim().split(':');
  if (p.length !== 3) return null;
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]),
                            (Number(h[0]) || 0) + OFFSET_BOGOTA,
                            Number(h[1]) || 0, Number(h[2]) || 0));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Copia los datos de las hojas "Employees" y "Records" del sistema anterior
 * a las hojas nuevas. Las hojas originales NO se tocan ni se renombran:
 * quedan ahí intactas como respaldo.
 * Solo importa si la hoja nueva todavía está vacía, así no duplica nada.
 */
function importarSistemaAnterior_() {
  var libro = ss_();
  var informe = [];

  /* ── Empleados ── */
  var oEmp = libro.getSheetByName(LEGACY_EMPLEADOS);
  var dEmp = libro.getSheetByName(HOJAS.EMPLEADOS);
  if (oEmp && dEmp && dEmp.getLastRow() <= 1 && oEmp.getLastRow() > 1) {
    var v = oEmp.getDataRange().getValues();
    var i1 = indices_(v[0], {
      id:     ['id', 'idempleado', 'employeeid'],
      nombre: ['name', 'nombre'],
      desc:   ['facedescriptor', 'descriptor', 'descriptores', 'rostro'],
      sede:   ['sede', 'sucursal'],
      creado: ['createdat', 'fecharegistro', 'fecha']
    });

    var filasE = [];
    for (var i = 1; i < v.length; i++) {
      if (i1.id < 0 || !v[i][i1.id]) continue;
      var texto = i1.desc >= 0 ? String(v[i][i1.desc] || '').trim() : '';
      var muestras = 0;
      if (texto) {
        try {
          var arr = JSON.parse(texto);
          if (arr.length && typeof arr[0] === 'number') arr = [arr];   // formato viejo: un descriptor plano
          texto = JSON.stringify(arr);
          muestras = arr.length;
        } catch (e) { texto = ''; }
      }
      filasE.push([
        v[i][i1.id],
        i1.nombre >= 0 ? v[i][i1.nombre] : '',
        '',
        i1.sede >= 0 ? v[i][i1.sede] : '',
        'SI',
        muestras,
        texto,
        i1.creado >= 0 ? v[i][i1.creado] : '',
        new Date()
      ]);
    }
    if (filasE.length) {
      dEmp.getRange(2, 1, filasE.length, H_EMPLEADOS.length).setValues(filasE);
      informe.push('Se importaron ' + filasE.length + ' empleados desde "' + LEGACY_EMPLEADOS +
                   '" con su rostro. La hoja original quedó intacta.');
    }
  }

  /* ── Registros ── */
  var oReg = libro.getSheetByName(LEGACY_REGISTROS);
  var dReg = libro.getSheetByName(HOJAS.REGISTROS);
  if (oReg && dReg && dReg.getLastRow() <= 1 && oReg.getLastRow() > 1) {
    var w = oReg.getDataRange().getValues();
    var i2 = indices_(w[0], {
      id:      ['id', 'idregistro'],
      emp:     ['employeeid', 'idempleado'],
      nombre:  ['name', 'nombre'],
      sede:    ['sede', 'sucursal'],
      fecha:   ['date', 'fecha'],
      entrada: ['checkin', 'entrada'],
      salida:  ['checkout', 'salida'],
      horas:   ['hoursworked', 'horas', 'horasnetas'],
      lat:     ['lat', 'latitud'],
      lng:     ['lng', 'lon', 'longitud']
    });

    var filasR = [], duplicadosDia = 0, vistos = {};
    for (var j = 1; j < w.length; j++) {
      if (i2.fecha < 0 || !w[j][i2.fecha]) continue;

      var entrada = fechaHoraLocal_(w[j][i2.fecha], i2.entrada >= 0 ? w[j][i2.entrada] : '');
      if (!entrada) continue;
      var salida = (i2.salida >= 0 && w[j][i2.salida])
        ? fechaHoraLocal_(w[j][i2.fecha], w[j][i2.salida]) : null;

      var claveDia = String(w[j][i2.emp]) + '|' + claveFecha_(w[j][i2.fecha]);
      var esDuplicado = !!vistos[claveDia];
      vistos[claveDia] = true;
      if (esDuplicado) duplicadosDia++;

      var netas = i2.horas >= 0 && w[j][i2.horas] !== '' ? Number(w[j][i2.horas]) || 0 : 0;
      var estado = esDuplicado ? 'DUPLICADO' : (salida ? 'COMPLETO' : 'PENDIENTE');
      var fechaDia = fechaDiaLocal_(entrada);
      var gps = (i2.lat >= 0 && w[j][i2.lat]) ? w[j][i2.lat] + ',' + w[j][i2.lng] : '';

      var fila = [];
      fila[C.ID]       = i2.id >= 0 && w[j][i2.id] ? w[j][i2.id] : 'IMP-' + j;
      fila[C.EMP]      = i2.emp >= 0 ? w[j][i2.emp] : '';
      fila[C.NOMBRE]   = i2.nombre >= 0 ? w[j][i2.nombre] : '';
      fila[C.FECHA]    = fechaDia;
      fila[C.DIA]      = nombreDia_(entrada);
      fila[C.ENTRADA]  = entrada;
      fila[C.SALIDA]   = salida || '';
      fila[C.BRUTAS]   = salida ? redondear_((salida - entrada) / 3600000, 2) : 0;
      fila[C.DESC]     = 0;
      fila[C.NETAS]    = netas;
      fila[C.SEDE_IN]  = i2.sede >= 0 ? w[j][i2.sede] : '';
      fila[C.SEDE_OUT] = '';
      fila[C.GPS_IN]   = gps;
      fila[C.GPS_OUT]  = '';
      fila[C.ESTADO]   = estado;
      fila[C.SEMANA]   = semanaIso_(fechaDia).clave;
      fila[C.MES]      = claveFecha_(fechaDia).substring(0, 7);
      fila[C.OBS]      = esDuplicado
        ? 'Importado del sistema anterior: segunda entrada del mismo día, no cuenta horas.'
        : 'Importado del sistema anterior.';
      filasR.push(fila);
    }

    if (filasR.length) {
      dReg.getRange(2, 1, filasR.length, H_REGISTROS.length).setValues(filasR);
      informe.push('Se importaron ' + filasR.length + ' marcaciones desde "' + LEGACY_REGISTROS + '".');
      if (duplicadosDia) {
        informe.push('De esas, ' + duplicadosDia + ' eran entradas repetidas del mismo día: quedaron marcadas ' +
                     'como DUPLICADO y no suman horas.');
      }
      var sinSalida = filasR.filter(function (f) { return f[C.ESTADO] === 'PENDIENTE'; }).length;
      if (sinSalida) {
        informe.push('⚠ ' + sinSalida + ' marcaciones no tienen hora de SALIDA (el botón nunca funcionó). ' +
                     'Quedaron como PENDIENTE en la hoja Inconsistencias para que las completes a mano.');
      }
    }
  }

  return informe;
}

/* ───────────────  CONSOLIDAR EMPLEADOS DUPLICADOS  ─────────────── */

/**
 * Junta los empleados que están registrados dos veces con el mismo nombre.
 * Conserva el registro más antiguo, le suma las muestras de rostro de los
 * duplicados (así reconoce mejor), reasigna sus marcaciones y deja los
 * duplicados como Activo = NO. No borra ninguna fila.
 *
 * Solo agrupa nombres realmente iguales ignorando mayúsculas y tildes:
 * "Fabian" y "fabian" sí; "David Monsalve" y "Donoban David Monsalve" no.
 */
function consolidarDuplicados() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return ['El sistema está ocupado, inténtalo de nuevo.'];

  try {
    var sEmp = hoja_(HOJAS.EMPLEADOS);
    var lista = leerEmpleados_();
    var grupos = {};

    lista.forEach(function (e) {
      var k = normalizar_(e.nombre);
      if (!k) return;
      (grupos[k] = grupos[k] || []).push(e);
    });

    var informe = [], reasignaciones = {};

    Object.keys(grupos).forEach(function (k) {
      var g = grupos[k].filter(function (e) { return e.activo; });
      if (g.length < 2) return;

      g.sort(function (a, b) { return a.fila - b.fila; });   // el más antiguo primero
      var principal = g[0];

      var muestras = [];
      g.forEach(function (e) {
        try {
          var d = JSON.parse(e.descriptores || '[]');
          if (d.length && typeof d[0] === 'number') d = [d];
          muestras = muestras.concat(d);
        } catch (err) { /* descriptor ilegible: se ignora */ }
      });
      if (muestras.length > 6) muestras = muestras.slice(0, 6);

      sEmp.getRange(principal.fila, 6).setValue(muestras.length);
      sEmp.getRange(principal.fila, 7).setValue(JSON.stringify(muestras));
      sEmp.getRange(principal.fila, 9).setValue(new Date());

      var nombres = [];
      for (var i = 1; i < g.length; i++) {
        sEmp.getRange(g[i].fila, 5).setValue('NO');
        reasignaciones[g[i].id] = { id: principal.id, nombre: principal.nombre };
        nombres.push(g[i].id);
      }

      informe.push('"' + principal.nombre + '": se unieron ' + g.length + ' registros en uno solo (' +
                   muestras.length + ' muestras de rostro). Desactivados: ' + nombres.join(', '));
    });

    // Reasignar las marcaciones de los duplicados al empleado principal
    var claves = Object.keys(reasignaciones);
    if (claves.length) {
      var datos = leerRegistros_();
      var cambiadas = 0;
      if (datos.filas.length) {
        for (var r = 0; r < datos.filas.length; r++) {
          var destino = reasignaciones[String(datos.filas[r][C.EMP])];
          if (!destino) continue;
          datos.filas[r][C.EMP] = destino.id;
          datos.filas[r][C.NOMBRE] = destino.nombre;
          cambiadas++;
        }
        if (cambiadas) {
          datos.hoja.getRange(2, 1, datos.filas.length, H_REGISTROS.length).setValues(datos.filas);
          informe.push(cambiadas + ' marcaciones se reasignaron al empleado correcto.');
        }
      }
      recalcularResumenes();
    }

    if (!informe.length) informe.push('No se encontraron empleados duplicados.');
    return informe;

  } finally {
    lock.releaseLock();
  }
}

/**
 * Promedia el GPS guardado en Registros para decirte la coordenada real de
 * cada sede. Sirve para corregir la constante SEDES sin adivinar.
 */
function sugerirCoordenadas() {
  var datos = leerRegistros_();
  var acum = {};

  datos.filas.forEach(function (d) {
    var sede = String(d[C.SEDE_IN] || '').trim();
    var gps = String(d[C.GPS_IN] || '').trim();
    if (!sede || !gps) return;
    var p = gps.split(',');
    var la = Number(p[0]), ln = Number(p[1]);
    if (!la || !ln) return;
    if (!acum[sede]) acum[sede] = { n: 0, la: 0, ln: 0, lats: [], lngs: [] };
    acum[sede].n++; acum[sede].la += la; acum[sede].ln += ln;
    acum[sede].lats.push(la); acum[sede].lngs.push(ln);
  });

  var lineas = [];
  Object.keys(acum).forEach(function (sede) {
    var a = acum[sede];
    var lat = a.la / a.n, lng = a.ln / a.n;
    var disp = Math.round(Math.max(
      Math.max.apply(null, a.lats) - Math.min.apply(null, a.lats),
      Math.max.apply(null, a.lngs) - Math.min.apply(null, a.lngs)) * 111000);
    var actual = buscarSede_(sede);
    var lejos = actual ? Math.round(distanciaMetros_(lat, lng, actual.lat, actual.lng)) : null;
    lineas.push(sede + '\n  lat: ' + lat.toFixed(6) + '   lng: ' + lng.toFixed(6) +
                '\n  (' + a.n + ' marcaciones, dispersión ' + disp + ' m' +
                (lejos !== null ? ', la coordenada actual está a ' + lejos + ' m' : '') + ')');
  });

  if (!lineas.length) lineas.push('Todavía no hay marcaciones con GPS para calcular coordenadas.');
  return lineas;
}

/**
 * Rellena ID, estado, semana y mes en los registros que vinieron de la hoja vieja,
 * para que el historial anterior también aparezca en los resúmenes.
 */
function normalizarRegistros_() {
  var s = ss_().getSheetByName(HOJAS.REGISTROS);
  if (!s) return 0;
  var ultima = s.getLastRow();
  if (ultima < 2) return 0;

  var rango = s.getRange(2, 1, ultima - 1, H_REGISTROS.length);
  var v = rango.getValues();

  var porNombre = {};
  leerEmpleados_().forEach(function (e) { porNombre[normalizar_(e.nombre)] = e; });

  var cambios = 0;
  for (var i = 0; i < v.length; i++) {
    var f = v[i];
    if (!f[C.FECHA] && !f[C.NOMBRE]) continue;

    var clave = claveFecha_(f[C.FECHA]);
    var toco = false;

    if (!f[C.ID])     { f[C.ID] = 'M' + clave.replace(/-/g, '') + '-' + (i + 2); toco = true; }
    if (!f[C.EMP])    { var e = porNombre[normalizar_(f[C.NOMBRE])]; if (e) { f[C.EMP] = e.id; toco = true; } }
    if (!f[C.ESTADO]) { f[C.ESTADO] = f[C.SALIDA] ? 'COMPLETO' : 'PENDIENTE'; toco = true; }
    if (!f[C.SEMANA] && clave) { f[C.SEMANA] = semanaIso_(clave).clave; toco = true; }
    if (!f[C.MES]    && clave) { f[C.MES] = clave.substring(0, 7); toco = true; }
    if (!f[C.DIA]    && clave) { f[C.DIA] = nombreDia_(new Date(clave + 'T12:00:00Z')); toco = true; }
    if (f[C.NETAS] === '' && f[C.ESTADO] !== 'ABIERTO') { f[C.NETAS] = 0; toco = true; }

    if (toco) cambios++;
  }

  if (cambios) rango.setValues(v);
  return cambios;
}

function aplicarFormato_(libro) {
  var reg = libro.getSheetByName(HOJAS.REGISTROS);
  if (reg) {
    reg.setFrozenRows(1);
    reg.getRange('D:D').setNumberFormat('yyyy-mm-dd');
    reg.getRange('F:G').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    reg.getRange('H:J').setNumberFormat('0.00');
  }
  var emp = libro.getSheetByName(HOJAS.EMPLEADOS);
  if (emp) {
    emp.setFrozenRows(1);
    emp.hideColumns(7); // Descriptores (texto larguísimo)
  }
  [HOJAS.DIARIO, HOJAS.SEMANAL, HOJAS.MENSUAL, HOJAS.INCONSISTENCIAS, HOJAS.CONFIG, HOJAS.AUDITORIA]
    .forEach(function (n) {
      var s = libro.getSheetByName(n);
      if (s) s.setFrozenRows(1);
    });

  var d = libro.getSheetByName(HOJAS.DIARIO);
  if (d) {
    d.getRange('A:A').setNumberFormat('yyyy-mm-dd');
    d.getRange('F:G').setNumberFormat('yyyy-mm-dd hh:mm');
    d.getRange('H:H').setNumberFormat('0.00');
  }
  [HOJAS.EMPLEADOS, HOJAS.REGISTROS, HOJAS.DIARIO, HOJAS.SEMANAL, HOJAS.MENSUAL,
   HOJAS.INCONSISTENCIAS, HOJAS.CONFIG, HOJAS.AUDITORIA].forEach(function (n) {
    var s = libro.getSheetByName(n);
    if (!s) return;
    s.getRange(1, 1, 1, s.getLastColumn())
     .setFontWeight('bold')
     .setBackground('#1f2937')
     .setFontColor('#ffffff');
  });
}

/* ─────────────────────────  AUDITORÍA  ───────────────────────── */

function auditar_(accion, idEmpleado, nombre, resultado, detalle) {
  try {
    var s = ss_().getSheetByName(HOJAS.AUDITORIA);
    if (!s) return;
    s.appendRow([new Date(), accion, idEmpleado || '', nombre || '', resultado || '', detalle || '']);
    // Poda: conservar las últimas 5000 líneas
    var n = s.getLastRow();
    if (n > 5200) s.deleteRows(2, n - 5000);
  } catch (e) { /* la auditoría nunca debe romper una marcación */ }
}

/* ─────────────────────────  EMPLEADOS  ───────────────────────── */

function leerEmpleados_() {
  var s = hoja_(HOJAS.EMPLEADOS);
  var v = s.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < v.length; i++) {
    if (!v[i][0]) continue;
    out.push({
      fila: i + 1,
      id: String(v[i][0]),
      nombre: String(v[i][1]),
      documento: String(v[i][2] || ''),
      sede: String(v[i][3] || ''),
      activo: String(v[i][4] || 'SI').toUpperCase() !== 'NO',
      muestras: Number(v[i][5] || 0),
      descriptores: String(v[i][6] || '')
    });
  }
  return out;
}

function buscarEmpleado_(id) {
  var lista = leerEmpleados_();
  for (var i = 0; i < lista.length; i++) if (lista[i].id === String(id)) return lista[i];
  return null;
}

function accionGetEmpleados_() {
  var lista = leerEmpleados_().filter(function (e) { return e.activo; });
  var version = 0;
  var salida = lista.map(function (e) {
    var d = [];
    try { d = JSON.parse(e.descriptores || '[]'); } catch (err) { d = []; }
    if (d.length && typeof d[0] === 'number') d = [d];   // formato viejo: un solo descriptor plano
    return { id: e.id, nombre: e.nombre, sede: e.sede, descriptores: d };
  });
  salida.forEach(function (e) { version += e.descriptores.length; });
  return { success: true, empleados: salida, version: lista.length + '.' + version };
}

function accionRegistrar_(p, cfg) {
  if (String(p.pin || '') !== String(cfg.PIN_ADMIN)) {
    return { success: false, code: 'PIN', message: 'PIN de administrador incorrecto.' };
  }
  var nombre = String(p.nombre || '').trim();
  if (nombre.length < 3) return { success: false, message: 'Escribe el nombre completo del empleado.' };

  var desc;
  try { desc = JSON.parse(p.descriptor); } catch (e) { desc = null; }
  if (!desc || !desc.length) return { success: false, message: 'No se capturó el rostro. Inténtalo de nuevo.' };
  if (typeof desc[0] === 'number') desc = [desc];

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { success: false, message: 'El sistema está ocupado. Intenta otra vez.' };

  try {
    var lista = leerEmpleados_();

    // ¿Ya existe alguien con ese nombre?
    for (var i = 0; i < lista.length; i++) {
      if (normalizar_(lista[i].nombre) === normalizar_(nombre)) {
        return { success: false, code: 'DUPLICADO',
                 message: 'Ya existe un empleado llamado "' + lista[i].nombre + '". Usa "Mejorar reconocimiento" en vez de registrarlo otra vez.' };
      }
    }

    // ¿Ese rostro ya está registrado a nombre de otra persona?
    var similar = rostroMasParecido_(lista, desc[0]);
    if (similar && similar.distancia < Number(cfg.UMBRAL_ROSTRO)) {
      return { success: false, code: 'ROSTRO_EXISTE',
               message: 'Ese rostro ya está registrado como "' + similar.empleado.nombre + '".' };
    }

    var s = hoja_(HOJAS.EMPLEADOS);
    var id = 'E' + Utilities.formatDate(new Date(), TZ, 'yyMMddHHmmss');
    s.appendRow([id, nombre, String(p.documento || ''), String(p.sede || ''), 'SI',
                 desc.length, JSON.stringify(comprimir_(desc)), new Date(), new Date()]);

    auditar_('REGISTRO', id, nombre, 'OK', 'Sede: ' + (p.sede || '-'));
    return { success: true, id: id, nombre: nombre, message: 'Empleado registrado: ' + nombre };
  } finally {
    lock.releaseLock();
  }
}

function accionAgregarRostro_(p, cfg) {
  if (String(p.pin || '') !== String(cfg.PIN_ADMIN)) {
    return { success: false, code: 'PIN', message: 'PIN de administrador incorrecto.' };
  }
  var desc;
  try { desc = JSON.parse(p.descriptor); } catch (e) { desc = null; }
  if (!desc || !desc.length) return { success: false, message: 'No se capturó el rostro.' };
  if (typeof desc[0] === 'number') desc = [desc];

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { success: false, message: 'El sistema está ocupado.' };

  try {
    var emp = buscarEmpleado_(p.empleadoId);
    if (!emp) return { success: false, message: 'Empleado no encontrado.' };

    var actuales = [];
    try { actuales = JSON.parse(emp.descriptores || '[]'); } catch (e) { actuales = []; }
    if (actuales.length && typeof actuales[0] === 'number') actuales = [actuales];

    actuales = actuales.concat(comprimir_(desc));
    if (actuales.length > 6) actuales = actuales.slice(actuales.length - 6);  // máx 6 muestras

    var s = hoja_(HOJAS.EMPLEADOS);
    s.getRange(emp.fila, 6).setValue(actuales.length);
    s.getRange(emp.fila, 7).setValue(JSON.stringify(actuales));
    s.getRange(emp.fila, 9).setValue(new Date());

    auditar_('AGREGAR_ROSTRO', emp.id, emp.nombre, 'OK', actuales.length + ' muestras');
    return { success: true, message: 'Reconocimiento mejorado (' + actuales.length + ' muestras de ' + emp.nombre + ').' };
  } finally {
    lock.releaseLock();
  }
}

function comprimir_(listaDesc) {
  return listaDesc.map(function (d) {
    return d.map(function (n) { return Math.round(Number(n) * 100000) / 100000; });
  });
}

function rostroMasParecido_(lista, descriptor) {
  var mejor = null;
  lista.forEach(function (emp) {
    var ds = [];
    try { ds = JSON.parse(emp.descriptores || '[]'); } catch (e) { return; }
    if (ds.length && typeof ds[0] === 'number') ds = [ds];
    ds.forEach(function (d) {
      if (!d || d.length !== descriptor.length) return;
      var suma = 0;
      for (var i = 0; i < d.length; i++) { var x = d[i] - descriptor[i]; suma += x * x; }
      var dist = Math.sqrt(suma);
      if (!mejor || dist < mejor.distancia) mejor = { empleado: emp, distancia: dist };
    });
  });
  return mejor;
}

/* ─────────────────────────  REGISTROS: ENTRADA / SALIDA  ───────────────────────── */

var C = { // índices 0-based de H_REGISTROS
  ID: 0, EMP: 1, NOMBRE: 2, FECHA: 3, DIA: 4, ENTRADA: 5, SALIDA: 6,
  BRUTAS: 7, DESC: 8, NETAS: 9, SEDE_IN: 10, SEDE_OUT: 11,
  GPS_IN: 12, GPS_OUT: 13, ESTADO: 14, SEMANA: 15, MES: 16, OBS: 17
};

function leerRegistros_() {
  var s = hoja_(HOJAS.REGISTROS);
  var ultima = s.getLastRow();
  if (ultima < 2) return { hoja: s, filas: [] };
  return { hoja: s, filas: s.getRange(2, 1, ultima - 1, H_REGISTROS.length).getValues() };
}

/** Última jornada del empleado que sigue ABIERTA (sin salida). */
function jornadaAbierta_(filas, empId) {
  for (var i = filas.length - 1; i >= 0; i--) {
    if (String(filas[i][C.EMP]) !== String(empId)) continue;
    if (String(filas[i][C.ESTADO]) === 'ABIERTO') return { fila: i + 2, datos: filas[i] };
    return null; // la más reciente ya está cerrada
  }
  return null;
}

/** ¿Ya hay un registro (abierto o cerrado) para ese empleado en esa fecha? */
function registroDelDia_(filas, empId, fechaClave) {
  for (var i = filas.length - 1; i >= 0; i--) {
    if (String(filas[i][C.EMP]) !== String(empId)) continue;
    if (claveFecha_(filas[i][C.FECHA]) === fechaClave) return { fila: i + 2, datos: filas[i] };
  }
  return null;
}

function accionEntrada_(p, cfg) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    return { success: false, code: 'OCUPADO', message: 'El sistema está ocupado, espera 2 segundos y reintenta.' };
  }

  try {
    var emp = buscarEmpleado_(p.empleadoId);
    if (!emp)         return { success: false, message: 'Empleado no encontrado. Vuelve a cargar la app.' };
    if (!emp.activo)  return { success: false, message: 'El empleado "' + emp.nombre + '" está inactivo.' };

    var geo = validarGeo_(p, cfg);
    if (!geo.ok) { auditar_('ENTRADA', emp.id, emp.nombre, 'RECHAZO', geo.message); return { success: false, code: 'GPS', message: geo.message }; }

    var ahora = ahora_();
    var hoy = fmt_(ahora, 'yyyy-MM-dd');
    var datos = leerRegistros_();

    // 1) ¿Tiene una jornada abierta?
    var abierta = jornadaAbierta_(datos.filas, emp.id);
    if (abierta) {
      var entradaPrev = new Date(abierta.datos[C.ENTRADA]);
      var horas = (ahora - entradaPrev) / 3600000;
      if (horas <= cfgNum_(cfg, 'MAX_HORAS_JORNADA')) {
        return { success: false, code: 'YA_ENTRO',
                 message: 'Ya tienes una ENTRADA abierta del ' + claveFecha_(abierta.datos[C.FECHA]) +
                          ' a las ' + fmt_(entradaPrev, 'HH:mm') + '. Marca la SALIDA primero.' };
      }
      // Jornada olvidada: se cierra como PENDIENTE y se permite la nueva entrada.
      cerrarComoPendiente_(datos.hoja, abierta.fila, 'Salida no marcada; cerrada automáticamente al iniciar una nueva jornada.');
      datos = leerRegistros_();
    }

    // 2) ¿Ya marcó entrada hoy?
    var deHoy = registroDelDia_(datos.filas, emp.id, hoy);
    if (deHoy) {
      var e0 = new Date(deHoy.datos[C.ENTRADA]);
      return { success: false, code: 'YA_ENTRO',
               message: 'Hoy ya registraste tu entrada a las ' + fmt_(e0, 'HH:mm') + '. Solo se permite una por día.' };
    }

    // 3) Crear el registro
    var sem = semanaIso_(ahora);
    var id = 'R' + fmt_(ahora, 'yyMMddHHmmss') + '-' + emp.id.slice(-4);
    var fechaDia = fechaDiaLocal_(ahora);

    var fila = [];
    fila[C.ID] = id;
    fila[C.EMP] = emp.id;
    fila[C.NOMBRE] = emp.nombre;
    fila[C.FECHA] = fechaDia;
    fila[C.DIA] = nombreDia_(ahora);
    fila[C.ENTRADA] = ahora;
    fila[C.SALIDA] = '';
    fila[C.BRUTAS] = '';
    fila[C.DESC] = '';
    fila[C.NETAS] = '';
    fila[C.SEDE_IN] = String(p.sede || emp.sede || '');
    fila[C.SEDE_OUT] = '';
    fila[C.GPS_IN] = p.lat && p.lng ? p.lat + ',' + p.lng : '';
    fila[C.GPS_OUT] = '';
    fila[C.ESTADO] = 'ABIERTO';
    fila[C.SEMANA] = sem.clave;
    fila[C.MES] = fmt_(ahora, 'yyyy-MM');
    fila[C.OBS] = '';

    datos.hoja.appendRow(fila);

    auditar_('ENTRADA', emp.id, emp.nombre, 'OK', p.sede + ' ' + fmt_(ahora, 'HH:mm:ss'));
    return {
      success: true,
      message: 'Entrada registrada: ' + fmt_(ahora, 'HH:mm') + ' · ' + emp.nombre,
      registro: { fecha: hoy, entrada: fmt_(ahora, 'HH:mm:ss'), salida: '', horas: 0, estado: 'ABIERTO' }
    };
  } finally {
    lock.releaseLock();
  }
}

function accionSalida_(p, cfg) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    return { success: false, code: 'OCUPADO', message: 'El sistema está ocupado, espera 2 segundos y reintenta.' };
  }

  try {
    var emp = buscarEmpleado_(p.empleadoId);
    if (!emp) return { success: false, message: 'Empleado no encontrado.' };

    var geo = validarGeo_(p, cfg);
    if (!geo.ok) { auditar_('SALIDA', emp.id, emp.nombre, 'RECHAZO', geo.message); return { success: false, code: 'GPS', message: geo.message }; }

    var ahora = ahora_();
    var datos = leerRegistros_();
    var abierta = jornadaAbierta_(datos.filas, emp.id);

    if (!abierta) {
      var hoy = fmt_(ahora, 'yyyy-MM-dd');
      var deHoy = registroDelDia_(datos.filas, emp.id, hoy);
      if (deHoy && String(deHoy.datos[C.ESTADO]) === 'COMPLETO') {
        return { success: false, code: 'YA_SALIO',
                 message: 'Hoy ya registraste tu salida a las ' + fmt_(new Date(deHoy.datos[C.SALIDA]), 'HH:mm') + '.' };
      }
      return { success: false, code: 'SIN_ENTRADA',
               message: 'No tienes una ENTRADA abierta. Marca primero la entrada.' };
    }

    var entrada = new Date(abierta.datos[C.ENTRADA]);
    var minutos = (ahora - entrada) / 60000;

    if (minutos < cfgNum_(cfg, 'MIN_MINUTOS_JORNADA')) {
      return { success: false, code: 'MUY_PRONTO',
               message: 'Acabas de marcar entrada hace ' + Math.round(minutos) + ' min. Espera al menos ' +
                        cfg.MIN_MINUTOS_JORNADA + ' minutos.' };
    }

    if (!cfgSi_(cfg, 'PERMITIR_TURNO_NOCTURNO') && fmt_(entrada, 'yyyy-MM-dd') !== fmt_(ahora, 'yyyy-MM-dd')) {
      cerrarComoPendiente_(datos.hoja, abierta.fila, 'Entrada del día anterior sin salida (turno nocturno deshabilitado).');
      return { success: false, code: 'OTRO_DIA',
               message: 'Tu entrada es de otro día y los turnos nocturnos están deshabilitados. Avisa al administrador.' };
    }

    var horasBrutas = redondear_(minutos / 60, 2);
    var descuento = horasBrutas > cfgNum_(cfg, 'UMBRAL_DESCUENTO_HORAS')
      ? redondear_(cfgNum_(cfg, 'DESCUENTO_ALMUERZO_MIN') / 60, 2) : 0;
    var netas = redondear_(Math.max(0, horasBrutas - descuento), 2);

    var estado = 'COMPLETO';
    var obs = String(abierta.datos[C.OBS] || '');
    if (horasBrutas > cfgNum_(cfg, 'MAX_HORAS_JORNADA')) {
      estado = 'ANOMALIA';
      obs = (obs ? obs + ' | ' : '') + 'Jornada de ' + horasBrutas + ' h: revisar.';
    }
    if (fmt_(entrada, 'yyyy-MM-dd') !== fmt_(ahora, 'yyyy-MM-dd')) {
      obs = (obs ? obs + ' | ' : '') + 'Turno nocturno: salida el ' + fmt_(ahora, 'yyyy-MM-dd') + '.';
    }

    var h = datos.hoja;
    h.getRange(abierta.fila, C.SALIDA + 1).setValue(ahora);
    h.getRange(abierta.fila, C.BRUTAS + 1).setValue(horasBrutas);
    h.getRange(abierta.fila, C.DESC + 1).setValue(descuento);
    h.getRange(abierta.fila, C.NETAS + 1).setValue(netas);
    h.getRange(abierta.fila, C.SEDE_OUT + 1).setValue(String(p.sede || ''));
    h.getRange(abierta.fila, C.GPS_OUT + 1).setValue(p.lat && p.lng ? p.lat + ',' + p.lng : '');
    h.getRange(abierta.fila, C.ESTADO + 1).setValue(estado);
    h.getRange(abierta.fila, C.OBS + 1).setValue(obs);

    auditar_('SALIDA', emp.id, emp.nombre, 'OK', netas + ' h netas');

    try { recalcularResumenes(); } catch (e) { /* nunca romper la marcación */ }

    return {
      success: true,
      message: 'Salida registrada: ' + fmt_(ahora, 'HH:mm') + ' · ' + horasAHHMM_(netas) + ' trabajadas',
      registro: {
        fecha: claveFecha_(abierta.datos[C.FECHA]),
        entrada: fmt_(entrada, 'HH:mm:ss'),
        salida: fmt_(ahora, 'HH:mm:ss'),
        horas: netas, horasTexto: horasAHHMM_(netas),
        brutas: horasBrutas, descuento: descuento, estado: estado
      }
    };
  } finally {
    lock.releaseLock();
  }
}

function cerrarComoPendiente_(hoja, fila, nota) {
  hoja.getRange(fila, C.ESTADO + 1).setValue('PENDIENTE');
  hoja.getRange(fila, C.BRUTAS + 1).setValue(0);
  hoja.getRange(fila, C.DESC + 1).setValue(0);
  hoja.getRange(fila, C.NETAS + 1).setValue(0);
  var obs = hoja.getRange(fila, C.OBS + 1).getValue();
  hoja.getRange(fila, C.OBS + 1).setValue((obs ? obs + ' | ' : '') + nota);
}

function buscarSede_(nombre) {
  var n = normalizar_(nombre);
  for (var i = 0; i < SEDES.length; i++) if (normalizar_(SEDES[i].nombre) === n) return SEDES[i];
  return null;
}

function distanciaMetros_(lat1, lng1, lat2, lng2) {
  var R = 6371000;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.pow(Math.sin(dLat / 2), 2) +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.pow(Math.sin(dLng / 2), 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * La distancia se calcula EN EL SERVIDOR a partir de lat/lng y la sede.
 * Así nadie puede falsificarla editando el HTML.
 */
function validarGeo_(p, cfg) {
  if (!cfgSi_(cfg, 'EXIGIR_GPS')) return { ok: true, distancia: null };

  var sede = buscarSede_(p.sede);
  if (!sede) return { ok: false, message: 'Selecciona una sede válida antes de marcar.' };

  var lat = Number(p.lat), lng = Number(p.lng);
  if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
    return { ok: false, message: 'No se pudo leer tu ubicación. Activa el GPS y da permiso al navegador.' };
  }

  var d = distanciaMetros_(lat, lng, sede.lat, sede.lng);
  var radio = cfgNum_(cfg, 'RADIO_GEO_METROS');
  if (d > radio) {
    return { ok: false, message: 'Estás a ' + Math.round(d) + ' m de ' + sede.nombre +
                                 ' (máximo permitido: ' + radio + ' m).' };
  }
  return { ok: true, distancia: Math.round(d) };
}

/* ─────────────────────────  CONSULTAS  ───────────────────────── */

function accionEstadoHoy_(p) {
  var emp = buscarEmpleado_(p.empleadoId);
  if (!emp) return { success: false, message: 'Empleado no encontrado.' };

  var datos = leerRegistros_();
  var hoy = fmt_(ahora_(), 'yyyy-MM-dd');

  var abierta = jornadaAbierta_(datos.filas, emp.id);
  var reg = abierta || registroDelDia_(datos.filas, emp.id, hoy);

  if (!reg) {
    return { success: true, nombre: emp.nombre, puedeEntrar: true, puedeSalir: false, registro: null };
  }

  var d = reg.datos;
  var estado = String(d[C.ESTADO]);
  var esDeHoy = claveFecha_(d[C.FECHA]) === hoy;

  return {
    success: true,
    nombre: emp.nombre,
    puedeEntrar: estado !== 'ABIERTO' && !esDeHoy,
    puedeSalir:  estado === 'ABIERTO',
    registro: {
      fecha: claveFecha_(d[C.FECHA]),
      dia: String(d[C.DIA] || ''),
      entrada: horaTexto_(d[C.ENTRADA], 'HH:mm:ss'),
      salida:  horaTexto_(d[C.SALIDA],  'HH:mm:ss'),
      horas: Number(d[C.NETAS] || 0),
      horasTexto: d[C.NETAS] !== '' ? horasAHHMM_(d[C.NETAS]) : '',
      sede: String(d[C.SEDE_IN] || ''),
      estado: estado
    }
  };
}

function accionHistorial_(p, cfg) {
  var datos = leerRegistros_();
  var dias = Number(p.dias || cfg.DIAS_HISTORIAL);
  var desde = fmt_(new Date(Date.now() - dias * 86400000), 'yyyy-MM-dd');
  var out = [];

  for (var i = datos.filas.length - 1; i >= 0 && out.length < 200; i--) {
    var d = datos.filas[i];
    if (!d[C.ID]) continue;
    var f = claveFecha_(d[C.FECHA]);
    if (f < desde) break;
    if (p.empleadoId && String(d[C.EMP]) !== String(p.empleadoId)) continue;

    out.push({
      fecha: f,
      dia: String(d[C.DIA] || ''),
      id: String(d[C.EMP]),
      nombre: String(d[C.NOMBRE]),
      sede: String(d[C.SEDE_IN] || ''),
      entrada: horaTexto_(d[C.ENTRADA], 'HH:mm'),
      salida:  horaTexto_(d[C.SALIDA],  'HH:mm'),
      horas: Number(d[C.NETAS] || 0),
      horasTexto: d[C.NETAS] !== '' ? horasAHHMM_(d[C.NETAS]) : '',
      estado: String(d[C.ESTADO] || '')
    });
  }
  return { success: true, registros: out };
}

/** Totales por empleado para la semana y el mes en curso. */
function accionReportes_(p) {
  var datos = leerRegistros_();
  var hoy = ahora_();
  var sem = semanaIso_(hoy);
  var mes = fmt_(hoy, 'yyyy-MM');

  var semana = {}, mensual = {};

  datos.filas.forEach(function (d) {
    if (!d[C.ID]) return;
    var nombre = String(d[C.NOMBRE]);
    var netas = Number(d[C.NETAS] || 0);
    var pendiente = String(d[C.ESTADO]) === 'PENDIENTE' ? 1 : 0;
    var trabajado = String(d[C.ESTADO]) === 'COMPLETO' || String(d[C.ESTADO]) === 'ANOMALIA' ? 1 : 0;

    if (String(d[C.SEMANA]) === sem.clave) {
      if (!semana[nombre]) semana[nombre] = { nombre: nombre, dias: 0, horas: 0, pendientes: 0 };
      semana[nombre].dias += trabajado;
      semana[nombre].horas += netas;
      semana[nombre].pendientes += pendiente;
    }
    if (String(d[C.MES]) === mes) {
      if (!mensual[nombre]) mensual[nombre] = { nombre: nombre, dias: 0, horas: 0, pendientes: 0 };
      mensual[nombre].dias += trabajado;
      mensual[nombre].horas += netas;
      mensual[nombre].pendientes += pendiente;
    }
  });

  function ordenar(obj) {
    return Object.keys(obj).map(function (k) {
      var r = obj[k];
      r.horas = redondear_(r.horas, 2);
      r.horasTexto = horasAHHMM_(r.horas);
      return r;
    }).sort(function (a, b) { return b.horas - a.horas; });
  }

  return {
    success: true,
    semana: { clave: sem.clave, desde: sem.desde, hasta: sem.hasta, filas: ordenar(semana) },
    mes:    { clave: mes, filas: ordenar(mensual) }
  };
}

/* ─────────────────────────  RESÚMENES  ───────────────────────── */

/**
 * Reconstruye Resumen_Diario, Resumen_Semanal, Resumen_Mensual e Inconsistencias
 * a partir de la hoja Registros. Es idempotente: se puede correr cuantas veces se quiera.
 */
function recalcularResumenes() {
  var libro = ss_();
  var datos = leerRegistros_();
  var filas = datos.filas.filter(function (d) { return d[C.ID]; });

  var diario = [], incons = [];
  var semMap = {}, mesMap = {};

  filas.forEach(function (d) {
    var fechaClave = claveFecha_(d[C.FECHA]);
    var estado = String(d[C.ESTADO] || '');
    var netas = Number(d[C.NETAS] || 0);
    var nombre = String(d[C.NOMBRE]);
    var empId = String(d[C.EMP]);

    diario.push([
      d[C.FECHA],
      String(d[C.DIA] || ''),
      empId,
      nombre,
      String(d[C.SEDE_IN] || ''),
      d[C.ENTRADA] || '',
      d[C.SALIDA] || '',
      estado === 'ABIERTO' ? '' : netas,
      estado === 'ABIERTO' ? 'En curso' : horasAHHMM_(netas),
      estado
    ]);

    if (estado === 'PENDIENTE' || estado === 'ANOMALIA' || (estado === 'ABIERTO' && fechaClave < fmt_(ahora_(), 'yyyy-MM-dd'))) {
      incons.push([
        d[C.FECHA], empId, nombre,
        d[C.ENTRADA] || '', d[C.SALIDA] || '', estado,
        estado === 'ANOMALIA' ? 'Jornada demasiado larga: verificar' : 'Falta marcar la SALIDA',
        String(d[C.ID])
      ]);
    }

    var cuenta = (estado === 'COMPLETO' || estado === 'ANOMALIA') ? 1 : 0;
    var pend = (estado === 'PENDIENTE' || estado === 'ABIERTO') ? 1 : 0;
    if (estado === 'DUPLICADO') { cuenta = 0; pend = 0; }

    var sk = String(d[C.SEMANA] || '') + '||' + empId;
    if (!semMap[sk]) {
      var s = semanaIso_(fechaClave);
      semMap[sk] = { semana: String(d[C.SEMANA] || s.clave), desde: s.desde, hasta: s.hasta,
                     id: empId, nombre: nombre, dias: 0, horas: 0, pend: 0 };
    }
    semMap[sk].dias += cuenta;
    semMap[sk].horas += netas;
    semMap[sk].pend += pend;

    var mk = String(d[C.MES] || fechaClave.substring(0, 7)) + '||' + empId;
    if (!mesMap[mk]) mesMap[mk] = { mes: String(d[C.MES] || fechaClave.substring(0, 7)),
                                    id: empId, nombre: nombre, dias: 0, horas: 0, pend: 0 };
    mesMap[mk].dias += cuenta;
    mesMap[mk].horas += netas;
    mesMap[mk].pend += pend;
  });

  // Ordenar: más reciente arriba
  diario.sort(function (a, b) { return new Date(b[0]) - new Date(a[0]) || String(a[3]).localeCompare(String(b[3])); });
  incons.sort(function (a, b) { return new Date(b[0]) - new Date(a[0]); });

  var semanal = Object.keys(semMap).map(function (k) {
    var r = semMap[k];
    var h = redondear_(r.horas, 2);
    return [r.semana, r.desde, r.hasta, r.id, r.nombre, r.dias, h, horasAHHMM_(h),
            r.dias ? redondear_(h / r.dias, 2) : 0, r.pend];
  }).sort(function (a, b) { return String(b[0]).localeCompare(String(a[0])) || String(a[4]).localeCompare(String(b[4])); });

  var mensual = Object.keys(mesMap).map(function (k) {
    var r = mesMap[k];
    var h = redondear_(r.horas, 2);
    return [r.mes, r.id, r.nombre, r.dias, h, horasAHHMM_(h),
            r.dias ? redondear_(h / r.dias, 2) : 0, r.pend];
  }).sort(function (a, b) { return String(b[0]).localeCompare(String(a[0])) || String(a[2]).localeCompare(String(b[2])); });

  volcar_(libro, HOJAS.DIARIO, H_DIARIO, diario);
  volcar_(libro, HOJAS.SEMANAL, H_SEMANAL, semanal);
  volcar_(libro, HOJAS.MENSUAL, H_MENSUAL, mensual);
  volcar_(libro, HOJAS.INCONSISTENCIAS, H_INCONSISTENCIAS, incons);

  return { diario: diario.length, semanal: semanal.length, mensual: mensual.length, inconsistencias: incons.length };
}

function volcar_(libro, nombre, headers, filas) {
  var s = libro.getSheetByName(nombre);
  if (!s) { s = libro.insertSheet(nombre); }
  s.clear();
  s.getRange(1, 1, 1, headers.length).setValues([headers]);
  s.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  if (filas.length) s.getRange(2, 1, filas.length, headers.length).setValues(filas);
  s.setFrozenRows(1);
  if (nombre === HOJAS.DIARIO) {
    s.getRange('A:A').setNumberFormat('yyyy-mm-dd');
    s.getRange('F:G').setNumberFormat('yyyy-mm-dd hh:mm');
    s.getRange('H:H').setNumberFormat('0.00');
  }
  if (nombre === HOJAS.INCONSISTENCIAS) {
    s.getRange('A:A').setNumberFormat('yyyy-mm-dd');
    s.getRange('D:E').setNumberFormat('yyyy-mm-dd hh:mm');
  }
}

/**
 * Cierra como PENDIENTE toda jornada abierta de días anteriores.
 * Se ejecuta con el disparador diario (23:55) y desde el menú.
 */
function cerrarJornadasOlvidadas() {
  var cfg = leerConfig();
  var datos = leerRegistros_();
  var hoy = fmt_(ahora_(), 'yyyy-MM-dd');
  var maxH = cfgNum_(cfg, 'MAX_HORAS_JORNADA');
  var n = 0;

  datos.filas.forEach(function (d, i) {
    if (String(d[C.ESTADO]) !== 'ABIERTO') return;
    var entrada = new Date(d[C.ENTRADA]);
    var horas = (Date.now() - entrada.getTime()) / 3600000;
    var esDeHoy = claveFecha_(d[C.FECHA]) === hoy;
    if (!esDeHoy && horas > maxH) {
      cerrarComoPendiente_(datos.hoja, i + 2, 'Cierre automático: nunca se marcó la salida.');
      n++;
    }
  });

  if (n) recalcularResumenes();
  return n;
}

/* ─────────────────────────  ROUTER HTTP  ───────────────────────── */

function doGet(e)  { return manejar_(e && e.parameter ? e.parameter : {}); }

function doPost(e) {
  var p = {};
  try {
    if (e && e.postData && e.postData.contents) p = JSON.parse(e.postData.contents);
  } catch (err) {
    p = (e && e.parameter) || {};
  }
  if (!p.action && e && e.parameter) p = e.parameter;
  return manejar_(p);
}

function manejar_(p) {
  try {
    var cfg = leerConfig();
    var accion = String(p.action || 'ping');
    var r;

    switch (accion) {
      case 'ping':          r = { success: true, version: VERSION, hora: fmt_(ahora_(), 'yyyy-MM-dd HH:mm:ss'),
                                  sedes: SEDES,
                                  config: { radio: Number(cfg.RADIO_GEO_METROS), exigirGps: cfgSi_(cfg, 'EXIGIR_GPS'),
                                            umbralRostro: Number(cfg.UMBRAL_ROSTRO) } }; break;
      case 'getSedes':      r = { success: true, sedes: SEDES }; break;
      case 'getEmployees':  r = accionGetEmpleados_(); break;
      case 'register':      r = accionRegistrar_(p, cfg); break;
      case 'addFace':       r = accionAgregarRostro_(p, cfg); break;
      case 'checkIn':       r = accionEntrada_(p, cfg); break;
      case 'checkOut':      r = accionSalida_(p, cfg); break;
      case 'getTodayRecord':r = accionEstadoHoy_(p); break;
      case 'getHistory':    r = accionHistorial_(p, cfg); break;
      case 'getReports':    r = accionReportes_(p); break;
      case 'rebuild':       r = { success: true, message: 'Resúmenes recalculados.', detalle: recalcularResumenes() }; break;
      default:              r = { success: false, message: 'Acción desconocida: ' + accion };
    }
    return json_(r);

  } catch (err) {
    auditar_('ERROR', p.empleadoId, p.nombre, 'EXCEPCION', String(err && err.message ? err.message : err));
    return json_({ success: false, code: 'ERROR', message: 'Error del servidor: ' + (err && err.message ? err.message : err) });
  }
}

/* ─────────────────────────  MENÚ EN LA HOJA  ───────────────────────── */

function onOpen() {
  var ui = ui_();
  if (!ui) return;
  ui.createMenu('⏱ Asistencia')
    .addItem('1. Instalar / reparar hojas', 'menuInstalar')
    .addItem('2. Recalcular resúmenes', 'menuRecalcular')
    .addItem('3. Cerrar jornadas olvidadas', 'menuCerrar')
    .addSeparator()
    .addItem('Unir empleados duplicados', 'menuConsolidar')
    .addItem('Sugerir coordenadas reales de sedes', 'menuCoordenadas')
    .addSeparator()
    .addItem('Crear disparadores automáticos', 'crearDisparadores')
    .addToUi();
}

/** Ejecuta esto UNA VEZ desde el editor: deja todo listo de una. */
function instalarTodo() {
  var informe = instalar();
  informe = informe.concat(configurarDisparadores_());
  Logger.log(informe.join('\n'));
  return informe.join('\n');
}

function menuInstalar() {
  var informe = instalar();
  var ui = ui_();
  if (ui) ui.alert('Instalación', informe.join('\n\n'), ui.ButtonSet.OK);
  return informe;
}

function menuRecalcular() {
  var r = recalcularResumenes();
  var ui = ui_();
  var txt = 'Días: ' + r.diario + '\nSemanas·empleado: ' + r.semanal +
            '\nMeses·empleado: ' + r.mensual + '\nInconsistencias: ' + r.inconsistencias;
  if (ui) ui.alert('Resúmenes actualizados', txt, ui.ButtonSet.OK);
  return txt;
}

function menuCerrar() {
  var n = cerrarJornadasOlvidadas();
  var ui = ui_();
  if (ui) ui.alert('Jornadas cerradas', n + ' jornada(s) sin salida quedaron como PENDIENTE.', ui.ButtonSet.OK);
  return n;
}

function menuConsolidar() {
  var ui = ui_();
  if (ui) {
    var r = ui.alert('Unir empleados duplicados',
      'Se van a unir los empleados que estén registrados dos veces con el mismo nombre.\n\n' +
      'El más antiguo se queda con todas las muestras de rostro, sus marcaciones se reasignan ' +
      'y los duplicados quedan como Activo = NO.\n\nNo se borra ninguna fila. ¿Continuar?',
      ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;
  }
  var informe = consolidarDuplicados();
  if (ui) ui.alert('Resultado', informe.join('\n\n'), ui.ButtonSet.OK);
  Logger.log(informe.join('\n'));
  return informe;
}

function menuCoordenadas() {
  var lineas = sugerirCoordenadas();
  var ui = ui_();
  var txt = lineas.join('\n\n') +
    '\n\nCopia estos valores en la constante SEDES del Apps Script y vuelve a implementar.';
  if (ui) ui.alert('Coordenadas reales según el GPS de las marcaciones', txt, ui.ButtonSet.OK);
  Logger.log(txt);
  return txt;
}

/** Programa las tareas automáticas y el menú de la hoja. Sin ventanas. */
function configurarDisparadores_() {
  var objetivo = ['cerrarJornadasOlvidadas', 'recalcularResumenes', 'onOpen'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (objetivo.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('cerrarJornadasOlvidadas').timeBased().atHour(23).nearMinute(50).everyDays(1).create();
  ScriptApp.newTrigger('recalcularResumenes').timeBased().everyHours(2).create();

  var informe = ['Disparadores creados: cierre de jornadas olvidadas a las 23:50 y recálculo de resúmenes cada 2 horas.'];

  // Si el proyecto es independiente, se instala el menú en la hoja por su ID.
  if (ID_HOJA) {
    try {
      ScriptApp.newTrigger('onOpen').forSpreadsheet(ID_HOJA).onOpen().create();
      informe.push('El menú "⏱ Asistencia" quedó instalado en la hoja (recárgala para verlo).');
    } catch (e) {
      informe.push('No se pudo instalar el menú en la hoja: ' + e.message);
    }
  }
  return informe;
}

function crearDisparadores() {
  var informe = configurarDisparadores_();
  var ui = ui_();
  if (ui) ui.alert('Listo', informe.join('\n\n'), ui.ButtonSet.OK);
  Logger.log(informe.join('\n'));
  return informe;
}
