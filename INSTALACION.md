# Instalación paso a paso

Tiempo estimado: **20 minutos**. No necesitas saber programar, solo copiar y pegar.

> **Por qué fallaba antes:** la URL del Apps Script que tenía el `index.html`
> (`AKfycbzVqrXs…/exec`) responde **404**. La app enviaba las marcaciones a una
> dirección que ya no existe, por eso los registros se perdían o se duplicaban.
> El paso 5 arregla eso de raíz.

---

## Paso 1 — Abre el editor de Apps Script

1. Abre tu hoja de cálculo de asistencia.
2. Menú **Extensiones → Apps Script**.
3. Se abre una pestaña nueva con un archivo llamado `Código.gs`.

## Paso 2 — Pega el código nuevo

1. Selecciona **todo** el contenido de `Código.gs` y bórralo.
2. Abre el archivo `apps-script/Codigo.gs` que te entregué, copia **todo** y pégalo ahí.
3. Presiona el ícono de **guardar** (💾).

## Paso 3 — Zona horaria del proyecto

1. En el menú de la izquierda: **⚙ Configuración del proyecto**.
2. Marca **Mostrar el archivo de manifiesto `appsscript.json`**.
3. Vuelve al **Editor**, abre `appsscript.json` y confirma que diga:
   ```json
   "timeZone": "America/Bogota"
   ```
   Si dice otra cosa, cámbialo y guarda.

## Paso 4 — Crea las hojas automáticamente

1. Arriba del editor, en la lista de funciones, elige **`instalar`**.
2. Presiona **▶ Ejecutar**.
3. Google te pedirá permisos:
   **Revisar permisos → tu cuenta → Configuración avanzada → Ir a (nombre del proyecto) → Permitir**.
   Es normal: le estás dando permiso a **tu propio** script sobre **tu propia** hoja.
4. Al terminar, vuelve a la hoja de cálculo. Vas a ver estas pestañas nuevas:

   | Hoja | Para qué sirve |
   |---|---|
   | **Empleados** | Quiénes son y su rostro registrado |
   | **Registros** | La base cruda: una fila por jornada, con GPS y auditoría |
   | **Resumen_Diario** | Un renglón por empleado por día, con horas |
   | **Resumen_Semanal** | Totales por semana (lunes a domingo) |
   | **Resumen_Mensual** | Totales por mes |
   | **Inconsistencias** | Días con salida faltante o jornadas raras — para corregir |
   | **Config** | Los parámetros que puedes cambiar sin tocar código |
   | **Auditoria** | Cada intento de marcación, aceptado o rechazado |

   > Si ya tenías datos con otra estructura, **nada se borra**: la hoja vieja se
   > conserva completa como `RESPALDO_…` y el sistema intenta migrar las columnas
   > que reconoce.

## Paso 5 — Publica el Apps Script (aquí se arregla el 404)

1. Arriba a la derecha: **Implementar → Nueva implementación**.
2. En el engranaje ⚙ elige **Aplicación web**.
3. Configura exactamente así:
   - **Descripción:** `Asistencia v2`
   - **Ejecutar como:** `Yo (tu correo)`
   - **Quién tiene acceso:** **`Cualquier persona`** ← *esto es obligatorio, si no la app no puede escribir*
4. **Implementar** → copia la **URL de la aplicación web** (termina en `/exec`).

> ⚠️ **Muy importante para el futuro:** cada vez que cambies el código debes ir a
> **Implementar → Administrar implementaciones → ✏️ editar → Versión: Nueva versión → Implementar**.
> Si solo guardas, la URL sigue sirviendo el código viejo. Y si creas una
> implementación *nueva* en vez de editar la existente, la URL cambia y hay que
> actualizarla en el `index.html`.

## Paso 6 — Conecta la app

1. Abre `index.html` y busca esta línea (está casi al inicio del `<script>`):
   ```js
   var SCRIPT_URL = 'PEGA_AQUI_TU_URL_DE_APPS_SCRIPT_TERMINADA_EN_/exec';
   ```
2. Reemplaza el texto entre comillas por la URL que copiaste en el paso 5.
3. Guarda.

## Paso 7 — Sube todo a GitHub

En tu repositorio `mi-asistencia` debe quedar así:

```
mi-asistencia/
├── index.html          ← el nuevo
└── models/             ← los archivos de reconocimiento facial (déjalos igual)
```

Sube el `index.html` nuevo reemplazando el anterior. La carpeta `models/` no se toca.

> La cámara **solo funciona por HTTPS**. GitHub Pages ya es HTTPS, así que sirve.
> Si abres el archivo con doble clic desde tu computador (`file://`) la cámara no va a funcionar.

## Paso 8 — Cambia el PIN de administrador

1. En la hoja de cálculo, pestaña **Config**.
2. Busca la fila `PIN_ADMIN` y cambia `1234` por un PIN tuyo.
3. Ese PIN es el que se pide para **registrar empleados nuevos** y para **mejorar el reconocimiento**.
   Sin él, cualquiera podría crear empleados falsos.

## Paso 9 — Activa las tareas automáticas

En la hoja de cálculo aparece un menú nuevo: **⏱ Asistencia**.

Entra a **Crear disparadores automáticos**. Eso programa:
- **23:50 todos los días** — cierra como `PENDIENTE` las jornadas donde nadie marcó salida.
- **Cada 2 horas** — recalcula los resúmenes diario, semanal y mensual.

## Paso 10 — Registra a la gente

1. Abre la app en el celular o tablet de cada sede.
2. Presiona **⚙ Registrar empleado / mejorar reconocimiento**.
3. Pestaña **Empleado nuevo** → nombre completo → PIN → **Capturar rostro y guardar**.
4. Repite con cada persona.

**Consejo importante:** después de registrar a alguien, entra a
**Mejorar rostro** y captura 2 o 3 muestras más de la misma persona en
condiciones distintas (con gafas, con luz de la mañana, con luz de la tarde).
Eso reduce muchísimo los "no te reconozco".

---

## Ajustes que puedes hacer sin tocar código

Todo esto se cambia en la pestaña **Config** de la hoja:

| Clave | Qué hace | Valor actual |
|---|---|---|
| `PIN_ADMIN` | PIN para registrar empleados | `1234` — **cámbialo** |
| `DESCUENTO_ALMUERZO_MIN` | Minutos de almuerzo que se descuentan | `60` |
| `UMBRAL_DESCUENTO_HORAS` | Desde cuántas horas se descuenta el almuerzo | `6` |
| `MAX_HORAS_JORNADA` | Más de esto se marca como anomalía | `16` |
| `MIN_MINUTOS_JORNADA` | Mínimo entre entrada y salida | `5` |
| `PERMITIR_TURNO_NOCTURNO` | `SI` deja que la salida caiga al día siguiente | `SI` |
| `EXIGIR_GPS` | `NO` desactiva el control de ubicación | `SI` |
| `RADIO_GEO_METROS` | Cuántos metros alrededor de la sede se permite marcar | `250` |
| `UMBRAL_ROSTRO` | Más bajo = más estricto el reconocimiento | `0.45` |
| `DIAS_HISTORIAL` | Días que muestra la pestaña Historial | `30` |

Después de cambiar algo, recarga la app en el celular.

**Las sedes y sus coordenadas** sí están en el código, en la constante `SEDES`
al inicio de `Codigo.gs`. Para corregir la ubicación de una sede: abre Google Maps,
clic derecho sobre el punto exacto, copia las coordenadas y pégalas ahí. Luego
**vuelve a implementar** (paso 5, nota importante).

> Las coordenadas que tenía el proyecto son aproximadas. Vale la pena
> corregirlas con el punto exacto de cada local; con un radio de 250 m eso
> importa.

---

## Si algo no funciona

| Síntoma | Causa casi segura | Solución |
|---|---|---|
| "Sin conexión con el servidor" | La URL del paso 6 está mal, o la implementación no quedó en "Cualquier persona" | Repite los pasos 5 y 6 |
| "El servidor no devolvió datos válidos" | El acceso quedó en "Solo yo" | Paso 5, cambia **Quién tiene acceso** |
| Los cambios al código no se ven | No creaste una versión nueva | **Administrar implementaciones → editar → Nueva versión** |
| La cámara no abre | Estás en `http://` o `file://` | Ábrela por HTTPS (GitHub Pages) |
| "Fuera del rango" siempre | Las coordenadas de la sede están mal | Corrige `SEDES` o sube `RADIO_GEO_METROS` |
| No reconoce a alguien | Pocas muestras de su rostro | **⚙ → Mejorar rostro**, agrega 2-3 muestras |
| Confunde dos personas | Umbral muy permisivo | Baja `UMBRAL_ROSTRO` a `0.40` en Config |
| Los resúmenes están desactualizados | El disparador no corrió aún | Menú **⏱ Asistencia → Recalcular resúmenes** |
