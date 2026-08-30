# Estado del sistema y cómo mantenerlo

**El sistema ya quedó instalado y funcionando el 30 de agosto de 2026.**
Este documento es para el día a día: qué hay montado, cómo se cambia y qué
hacer cuando algo falle.

---

## Qué quedó montado

| Pieza | Dónde está |
|---|---|
| **App** (la que abren en las sedes) | https://estebanchipre-sys.github.io/mi-asistencia/ |
| **Backend** | Proyecto de Apps Script **"Control de Asistencia v2"**, en la cuenta estebanchipre@gmail.com |
| **URL del backend** | `https://script.google.com/macros/s/AKfycbwTVavs23gzqav9OpKSn0l_3mWzlPY2euIQFiI-HpQbzP2PHwFZZFD9DDexHG7XBio/exec` |
| **Base de datos** | La hoja **ControlAsistencia** de siempre |
| **Código fuente** | Este repositorio, `apps-script/Codigo.gs` e `index.html` |

### Por qué el backend es un proyecto independiente

El Apps Script que estaba **vinculado** a la hoja desapareció — por eso la URL
anterior respondía **404** y las marcaciones se perdían. El nuevo backend es un
proyecto **independiente** que apunta a la hoja por su ID (la constante
`ID_HOJA` al inicio de `Codigo.gs`). Así, aunque alguien toque el vínculo de la
hoja, el sistema sigue funcionando.

### Hojas nuevas en la hoja de cálculo

| Hoja | Para qué sirve |
|---|---|
| **Empleados** | Quiénes son y sus muestras de rostro |
| **Registros** | La base cruda: una fila por jornada, con GPS y auditoría |
| **Resumen_Diario** | Un renglón por empleado por día |
| **Resumen_Semanal** | Totales por semana (lunes a domingo) |
| **Resumen_Mensual** | Totales por mes — es la hoja para liquidar nómina |
| **Inconsistencias** | Días con salida faltante, duplicados y jornadas raras |
| **Config** | Los parámetros ajustables |
| **Auditoria** | Cada intento de marcación, aceptado o rechazado |

**`Employees` y `Records` (las viejas) siguen ahí, intactas.** No se tocaron ni
se renombraron: sus datos se copiaron a las hojas nuevas.

---

## Lo primero que deberías hacer

### 1. Cambia el PIN de administrador

Hoja **Config** → fila `PIN_ADMIN` → cámbialo (viene en `1234`).
Ese PIN es el que pide la app para registrar empleados nuevos o mejorar un
rostro. Sin él, cualquiera podría crear empleados falsos.

### 2. Une los empleados duplicados

Tienes 14 empleados registrados pero son 9 personas:

- Fabian / fabian
- Julian Jaramillo / Julián Jaramillo
- Juan José González ×2
- Carlos Alberto palacio Uribe ×2
- Juan Andrés Flórez ×2 (uno quedó en Guayabal y otro en Centro)
- David Monsalve / Donoban David Monsalve ← **este no lo une el sistema**, los
  nombres son distintos. Revísalo tú.

Menú **⏱ Asistencia → Unir empleados duplicados**. El más antiguo se queda con
todas las muestras de rostro (queda reconociendo mejor), sus marcaciones se
reasignan al empleado correcto y el duplicado queda en `Activo = NO`.
**No borra ninguna fila.**

### 3. Verifica las coordenadas de las otras 5 sedes

La de **Guayabal - Julián** está verificada con el GPS de 17 marcaciones reales
(`6.212850, -75.585934`). La coordenada que tenía el código antes estaba a
**~600 metros** del local: con el radio de 250 m nadie habría podido marcar.

Las otras cinco nunca han tenido una marcación, así que sus coordenadas siguen
sin comprobar. Cuando alguien marque desde una de ellas, usa el menú
**⏱ Asistencia → Sugerir coordenadas reales de sedes**: promedia el GPS de las
marcaciones guardadas y te dice el punto exacto. Copia esos valores en la
constante `SEDES` del Apps Script y vuelve a implementar (ver abajo).

Mientras tanto, si alguien no puede marcar en otra sede, sube
`RADIO_GEO_METROS` en Config temporalmente.

### 4. Completa las 17 marcaciones sin salida

Ninguna marcación anterior tiene hora de salida: el botón nunca funcionó.
Todas quedaron como `PENDIENTE` en la hoja **Inconsistencias**. Si necesitas
esas horas para nómina, complétalas a mano (ver más abajo).

---

## Ajustes sin tocar código — hoja **Config**

| Clave | Qué hace | Valor |
|---|---|---|
| `PIN_ADMIN` | PIN para registrar empleados | `1234` — **cámbialo** |
| `DESCUENTO_ALMUERZO_MIN` | Minutos de almuerzo que se descuentan | `60` |
| `UMBRAL_DESCUENTO_HORAS` | Desde cuántas horas se aplica el descuento | `6` |
| `MAX_HORAS_JORNADA` | Más de esto se marca como anomalía | `16` |
| `MIN_MINUTOS_JORNADA` | Mínimo entre entrada y salida | `5` |
| `PERMITIR_TURNO_NOCTURNO` | `SI` deja que la salida caiga al día siguiente | `SI` |
| `EXIGIR_GPS` | `NO` desactiva el control de ubicación | `SI` |
| `RADIO_GEO_METROS` | Metros permitidos alrededor de la sede | `250` |
| `UMBRAL_ROSTRO` | Más bajo = más estricto el reconocimiento | `0.45` |
| `DIAS_HISTORIAL` | Días que muestra la pestaña Historial | `30` |

Los cambios aplican de inmediato; solo hay que recargar la app en el celular.

---

## Menú **⏱ Asistencia** (en la hoja de cálculo)

- **Instalar / reparar hojas** — recrea lo que falte. Seguro de ejecutar cuantas
  veces quieras: nunca borra datos.
- **Recalcular resúmenes** — reconstruye diario, semanal, mensual e inconsistencias.
- **Cerrar jornadas olvidadas** — marca como `PENDIENTE` las entradas viejas sin salida.
- **Unir empleados duplicados** — lo del punto 2.
- **Sugerir coordenadas reales de sedes** — lo del punto 3.
- **Crear disparadores automáticos** — ya están creados; solo si hay que rehacerlos.

Si no ves el menú, recarga la hoja.

### Tareas automáticas ya programadas

- **23:50 todos los días** — cierra como `PENDIENTE` las jornadas sin salida.
- **Cada 2 horas** — recalcula los resúmenes.

---

## Cómo cambiar el código

Cada vez que edites `Codigo.gs`:

1. Abre el proyecto: script.google.com → **Control de Asistencia v2**
2. Pega el código y guarda (💾)
3. **Implementar → Administrar implementaciones → ✏️ editar → Versión: `Nueva versión` → Implementar**

> ⚠️ **El paso 3 es obligatorio.** Si solo guardas, la URL sigue sirviendo el
> código viejo y parece que tu cambio "no hizo nada". Y usa **editar la
> implementación existente**, no "Nueva implementación": esa última crea una
> URL distinta y habría que cambiarla en el `index.html`.

Para cambiar el `index.html`: súbelo a este repositorio y GitHub Pages lo
publica solo en un par de minutos.

---

## Cómo corregir un día a mano

Si alguien olvidó marcar la salida:

1. Ve a la hoja **Inconsistencias** y ubica el `ID_Registro`.
2. Búscalo en la hoja **Registros**.
3. Escribe la hora real en `Salida` (formato `2026-08-31 17:00:00`).
4. Calcula: `Horas_Brutas` = salida − entrada; `Descuento` = 1 si son más de 6 h;
   `Horas_Netas` = brutas − descuento.
5. Cambia `Estado` a `COMPLETO` y anota el motivo en `Observaciones`.
6. Menú **⏱ Asistencia → Recalcular resúmenes**.

---

## Si algo falla

| Síntoma | Causa casi segura | Solución |
|---|---|---|
| "Sin conexión con el servidor" | La implementación quedó en "Solo yo" | Implementar → Administrar → editar → Quién tiene acceso: **Cualquiera** |
| Los cambios al código no se ven | No creaste una versión nueva | Ver "Cómo cambiar el código" |
| La cámara no abre | La página no está en HTTPS | Ábrela desde el enlace de GitHub Pages, no con doble clic al archivo |
| "Fuera del rango" siempre | Coordenadas de la sede mal | Menú → Sugerir coordenadas reales de sedes |
| No reconoce a alguien | Pocas muestras de su rostro | En la app: ⚙ → Mejorar rostro → agrega 2-3 muestras |
| Confunde dos personas | Umbral muy permisivo | Baja `UMBRAL_ROSTRO` a `0.40` en Config |
| Resúmenes desactualizados | El disparador aún no corrió | Menú → Recalcular resúmenes |
| "Ya tienes una ENTRADA abierta" | No marcó salida el día anterior | Es correcto. Corrige ese día a mano o usa "Cerrar jornadas olvidadas" |
