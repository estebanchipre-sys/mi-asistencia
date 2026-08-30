# Control de Asistencia · v2

Marcación de entrada y salida por reconocimiento facial, con Google Sheets como
base de datos y control de ubicación por GPS.

**App en vivo:** https://estebanchipre-sys.github.io/mi-asistencia/
**→ Estado del sistema y mantenimiento: [INSTALACION.md](INSTALACION.md)**

> Instalado y verificado el 30 de agosto de 2026.

---

## Qué cambió respecto a la versión anterior

Los errores de marcación no venían de una sola cosa. Estos eran los problemas:

| Problema | Qué pasaba | Cómo quedó |
|---|---|---|
| **El Apps Script vinculado a la hoja ya no existía** | La URL respondía 404: las marcaciones se enviaban a una dirección muerta, el usuario veía "registrado" y nada se guardaba. **Ninguna de las 17 marcaciones tenía hora de salida** | Backend nuevo como proyecto independiente que apunta a la hoja por su ID; no depende del vínculo |
| **La sede Guayabal - Julián estaba a ~600 m de su ubicación real** | Con un radio estricto, nadie habría podido marcar | Coordenada recalculada con el GPS de las 17 marcaciones reales (dispersión de 34 m) |
| **14 empleados registrados eran 9 personas** | Cada intento fallido creaba un empleado nuevo, y sus marcaciones quedaban repartidas entre los duplicados | Función que los une conservando todas las muestras de rostro y reasignando las marcaciones |
| **Se llamaba al servidor dentro del bucle de video** | 4-8 peticiones por segundo mientras hubiera una cara enfrente. Google limita las cuotas y empezaba a rechazar y a duplicar | El bucle de video **nunca** llama al servidor. Solo consulta una vez, cuando confirma la identidad |
| **Sin control de duplicados** | Dos toques seguidos = dos registros | `LockService` + una sola entrada y una sola salida por día, validado en el servidor |
| **El rostro se "reconocía" con un solo frame** | Un parpadeo confundía a la persona y marcaba a nombre de otro | Se exigen 4 detecciones seguidas de la misma persona antes de habilitar los botones |
| **El descriptor facial viajaba en la URL** | ~2.500 caracteres en un `GET`; a veces se cortaba y el registro fallaba en silencio | Todo va por `POST` |
| **La distancia GPS se calculaba en el navegador** | Se podía falsear editando el HTML | La distancia se calcula **en el servidor** a partir de lat/lng |
| **Radio de 1.000 metros** | Se podía marcar desde 10 cuadras de distancia | 250 m configurables |
| **Cualquiera podía registrarse** | Bastaba escribir un nombre | Requiere PIN de administrador |
| **Sin resúmenes** | Solo un listado plano | Hojas de resumen diario, semanal y mensual + hoja de inconsistencias |
| **Fechas desfasadas un día** | La fecha se construía en la zona horaria del servidor, no en la de Colombia | Todo el cálculo de fechas está anclado a `America/Bogota` |
| **Horas mal leídas al importar** | Sheets guarda las horas ancladas al 30/12/1899 y Bogotá tenía otro huso (−04:56) en esa fecha; formatear con zona horaria desplazaba la hora casi 4 minutos | Las horas se leen sin aplicar zona horaria |
| **El resumen mensual salía vacío** | Sheets convertía el texto `2026-08` en la fecha 1-ago-2026, y la comparación fallaba | La clave del mes se normaliza venga como texto o como fecha |

---

## Reglas de negocio

1. **Una sola ENTRADA por empleado por día.** El segundo intento se rechaza con
   el mensaje de a qué hora ya marcó.
2. **Una sola SALIDA por jornada.** Y no antes de 5 minutos de la entrada.
3. **Turnos nocturnos permitidos.** Si alguien entra el martes a las 22:00 y sale
   el miércoles a las 06:00, las 8 horas se acumulan al **martes**, que es el día
   en que empezó la jornada.
4. **Salida olvidada → `PENDIENTE`.** El día queda en 0 horas y aparece en la
   hoja **Inconsistencias** para que un administrador lo corrija a mano. Nunca se
   inventan horas.
5. **Almuerzo:** se descuenta 1 hora en jornadas de más de 6 horas brutas.
   9 h marcadas = 8 h laboradas.
6. **Jornadas de más de 16 horas** se guardan pero se marcan como `ANOMALIA`.
7. **Ubicación:** solo se puede marcar dentro de 250 m de la sede seleccionada.

Todos estos números se cambian desde la pestaña **Config** de la hoja, sin tocar código.

---

## Estructura de la hoja de cálculo

### `Registros` — la base cruda
Una fila por jornada. Es la fuente de la verdad; el resto se calcula de aquí.

`ID_Registro · ID_Empleado · Nombre · Fecha · Dia · Entrada · Salida · Horas_Brutas ·
Descuento · Horas_Netas · Sede_Entrada · Sede_Salida · GPS_Entrada · GPS_Salida ·
Estado · Semana · Mes · Observaciones`

**Estados:** `ABIERTO` (en turno) · `COMPLETO` (jornada cerrada) ·
`PENDIENTE` (nunca marcó salida) · `ANOMALIA` (jornada demasiado larga) ·
`DUPLICADO` (entrada repetida del mismo día, importada del sistema anterior; no suma horas).

### `Resumen_Diario`
Un renglón por empleado por día, ordenado del más reciente al más viejo.
Listo para filtrar o hacer tabla dinámica.

### `Resumen_Semanal`
Semana ISO (lunes a domingo) por empleado: días trabajados, horas netas,
promedio diario y cuántos días quedaron sin salida.

### `Resumen_Mensual`
Lo mismo, agrupado por mes. Es la hoja que sirve para liquidar nómina.

### `Inconsistencias`
Todo lo que necesita revisión humana: salidas faltantes y jornadas anómalas.
**Revísala una vez por semana.**

### `Auditoria`
Cada intento de marcación con su resultado, aceptado o rechazado. Sirve para
saber qué pasó cuando alguien reclama. Se conservan las últimas 5.000 líneas.

### `Config`
Los parámetros ajustables. Ver la tabla en [INSTALACION.md](INSTALACION.md).

### `Empleados`
Nombre, documento, sede y las muestras del rostro. La columna `Descriptores`
está oculta a propósito: son números del modelo facial, no una foto.

---

## Cómo corregir un día a mano

Si alguien olvidó marcar la salida:

1. Ve a la hoja **Inconsistencias** y ubica el `ID_Registro`.
2. Búscalo en la hoja **Registros**.
3. Escribe la hora real en la columna `Salida` (formato `2026-08-31 17:00:00`).
4. Calcula: `Horas_Brutas` = salida − entrada; `Descuento` = 1 si son más de 6 h;
   `Horas_Netas` = brutas − descuento.
5. Cambia `Estado` a `COMPLETO` y anota el motivo en `Observaciones`.
6. Menú **⏱ Asistencia → Recalcular resúmenes**.

---

## Menú de la hoja

**⏱ Asistencia**

- **Instalar / reparar hojas** — vuelve a crear lo que falte. Seguro de ejecutar
  cuantas veces quieras: nunca borra datos, respalda lo que no reconoce.
- **Recalcular resúmenes** — reconstruye diario, semanal, mensual e inconsistencias.
- **Cerrar jornadas olvidadas** — marca como `PENDIENTE` las entradas viejas sin salida.
- **Unir empleados duplicados** — junta los que están registrados dos veces con el
  mismo nombre, conservando todas las muestras de rostro. No borra filas.
- **Sugerir coordenadas reales de sedes** — promedia el GPS de las marcaciones
  guardadas y te da el punto exacto de cada sede.
- **Crear disparadores automáticos** — programa las tareas de arriba.

---

## Pruebas

El proyecto trae un simulador que corre la lógica del servidor fuera de Google:

```bash
node pruebas/simulador.js
```

Cubre 44 casos: doble entrada, doble salida, turno nocturno que cruza medianoche,
salida olvidada, descuento de almuerzo, control de GPS, semana ISO y los resúmenes.
Si vas a tocar `Codigo.gs`, corre esto antes de subirlo.

Además se verificó contra el sistema real, ya desplegado: entrada aceptada,
segunda entrada rechazada, marcación desde 9,8 km rechazada, salida al minuto
rechazada, salida válida registrada con sus horas, y segunda salida rechazada.

---

## Archivos

```
index.html               La app (súbela a GitHub Pages)
models/                  Modelos de reconocimiento facial (no se tocan)
apps-script/Codigo.gs    El backend (se pega en el editor de Apps Script)
pruebas/simulador.js     Pruebas automáticas de la lógica
INSTALACION.md           Guía paso a paso
```
