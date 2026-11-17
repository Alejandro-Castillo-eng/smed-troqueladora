# SMED · Troqueladora

Aplicación para registrar el tiempo total de setup y la duración de sus actividades.
Incluye acceso por rol (analista y operario), actividades editables, repeticiones, omisiones,
correcciones, historial y análisis con exportación a CSV y Excel.

## Usuarios y roles

| Rol | Usuario | Contraseña | Opciones |
|---|---|---|---|
| Analista | `usuario` | `artefacto` | Nuevo setup con preparación externa, Historial, Análisis y Configuración. |
| Operario | `operario` | `troqueladora` | Nuevo setup con preparación externa, sin editar la lista de actividades. |

La pantalla de inicio de sesión es del operario: pide directamente usuario y contraseña,
con las credenciales del operario a la derecha, y rechaza las del analista. Dentro de la
aplicación, el operario tiene el botón **Cambiar a analista**, que pide las credenciales del
analista, cierra la sesión del operario y conserva la medición en curso. Al cerrar sesión se
vuelve a la pantalla del operario.

Cada rol ve únicamente sus secciones. El servidor también lo exige: el operario solo
puede leer la configuración y guardar o corregir las mediciones que él registró; el
historial, el análisis y los demás cambios responden 403. Al finalizar un setup, el
operario vuelve a preparar el siguiente y el analista ve la medición en el Historial.

## Aplicación publicada en GitHub Pages

https://alejandro-castillo-eng.github.io/smed-troqueladora/

Analista: **usuario** / **artefacto** · Operario: **operario** / **troqueladora**.

El workflow `Publicar aplicación en GitHub Pages` publica automáticamente al cambiar
la rama `main`. El deployment aparece en el entorno `github-pages` del repositorio.
La versión de revisión mantiene las pantallas y los 24 ejemplos, pero guarda las
mediciones en el navegador de cada visitante: no comparte registros entre equipos.
Su acceso es una demostración de interfaz, no autenticación de servidor.

GitHub Pages no ejecuta Python. El backend con SQLite queda disponible para ejecución
local; el script `scripts/build_pages.py` prepara por separado la versión estática.
Solo se publican HTML, JavaScript y ejemplos simulados, sin base de datos ni sesiones.

## Ejecutar el backend local

Requiere Python 3.10 o posterior. No hay paquetes que instalar.

```powershell
python server.py
```

Abre http://127.0.0.1:8080. Para facilitar la revisión del profesor, el acceso del
operario se muestra junto al inicio de sesión y el del analista en el diálogo
**Cambiar a analista** (ver la tabla de roles). La autenticación se valida en el servidor, con contraseña
derivada mediante PBKDF2 y sesión en cookie HttpOnly.

## Preparación externa

En **Preparar la medición**, con la máquina todavía produciendo, el operario y el analista
completan dos tarjetas:

- **Datos del cambio:** se escribe la orden o pedido. Con los pedidos de ejemplo
  (`P-0249`, `P-0250`, `P-0251`, con los productos del piloto) se llenan solos el producto,
  la cantidad, la medida y el troquel; otro número se acepta sin autollenado. El cronómetro
  de **preparación externa** empieza al ingresar el pedido y se detiene al completar el checklist.
- **Kit de materiales:** *Paso 1 · Revisión de la orden* (código y cantidad, dimensiones,
  cartón, calidad y tolerancias) y *Paso 2 · Kit del siguiente pedido* (troquel verificado e
  inspeccionado, láminas en el carrito, herramientas, plantilla y ficha técnica): 10 puntos.

El botón **Kit completo · ver pasos** se activa con los 10 puntos y muestra los pasos siguientes
con **Iniciar parada y medición**; con el kit incompleto la parada no se inicia. Las marcas, el
pedido y el cronómetro se conservan al recargar. La medición guarda el kit, el pedido y los minutos
de preparación externa, y el resultado los muestra.

El operario no ve la lista editable de actividades para no distraerse durante el cambio:
completa la preparación externa, presiona **Kit completo · ver pasos**, luego **Iniciar
parada y medición** y, al acabar,
**Terminar medición**. Mientras tanto solo ve el cronómetro de la parada total. Su medición
se guarda como **solo parada total**: entra al Historial, a la evolución y al cumplimiento
de la meta, pero no al Pareto, a la variación ni a las columnas por actividad del Excel.
El analista sigue midiendo actividad por actividad.

El Historial y la hoja Detalle del Excel incluyen **Registrado por** (Analista u Operario
y su usuario). Lo calcula el servidor a partir de quién creó la medición; las anteriores
a los roles, incluidos los ejemplos, figuran como «Otro operario».

## Terminar una medición

Durante la medición, **Terminar medición** detiene el tiempo y guarda lo registrado
hasta ese momento. Incluye la actividad actual y marca las pendientes como omitidas,
con cero minutos. Se abre el resultado para revisarlo. Si falla el guardado, se
conservan los datos y la hora de fin para reintentar, incluso después de recargar.

## Almacenamiento

SQLite guarda las mediciones, correcciones, configuración y cuentas en
`data/smed.sqlite3`. Una base creada con la versión anterior conserva su cuenta de
supervisor como analista, añade el operario y cierra las sesiones abiertas. Los borradores de la medición en curso permanecen en el navegador.
Al acceder se importan una sola vez los registros del prototipo anterior si existen
allí; los identificadores existentes no se sobrescriben.

Para hacer una copia, detén el servidor y copia la carpeta `data`. La base de datos,
sus usuarios y sesiones **no se suben a GitHub**.

## Datos de ejemplo

En el primer arranque se generan **24 registros identificados como Simulado**,
repartidos entre varios días y horas. Incluyen actividades normales, repeticiones
y omisiones. Son ejemplos inventados, no mediciones reales de planta.

El análisis reúne automáticamente Planta, Simulado y Piloto. Los datos Demo se excluyen;
las mediciones con omisiones se conservan en el historial y su detalle. El promedio
por actividad utiliza las mediciones completas. El botón para restablecer simulados
renueva solo estos ejemplos y conserva las mediciones de planta y piloto.

## Análisis

- **Evolución de la parada:** parada total de cada medición completa frente a la meta,
  con el porcentaje de mediciones que la cumplen.
- **Pareto de actividades:** actividades ordenadas por tiempo promedio con el porcentaje
  acumulado; destaca las que suman el 80 % del tiempo.
- **Actividades internas y externas:** al marcar las actividades que podrían prepararse
  con la máquina en marcha, estima la nueva parada y la compara con la meta. La selección
  se guarda en la configuración compartida.
- **Variación por actividad:** promedio, mínimo, máximo y coeficiente de variación;
  más de 25 % indica una actividad poco estandarizada.

## Pruebas

```powershell
python -m unittest test_backend -v
```

Las pruebas utilizan una base temporal y verifican acceso por rol, migración de cuentas, persistencia, validación,
importación, correcciones concurrentes, guardado idempotente y renovación de ejemplos.

La medición, la exportación Excel y las pantallas de cada rol se comprueban con
Node.js 18 o posterior, sin instalar paquetes:

```sh
node --test test_excel_export.cjs test_measurement.cjs test_access.cjs
```

## Exportar Excel

Desde Historial, **Exportar Excel** descarga todas las mediciones guardadas.
La hoja **Mediciones** contiene una fila por setup: primero la fecha y después una
columna por actividad, con número, nombre y duración en minutos. Reúne las actividades
de todos los planes exportados y las numera en su orden de aparición; los nombres
iguales comparten columna aunque cambien de posición o identificador entre planes.
Las repeticiones registradas se suman y las actividades ausentes u omitidas muestran
**No se registró**. Un tiempo registrado de cero se conserva como número.

Al final aparecen las horas, el origen y la parada total. La hoja **Detalle** reproduce la tabla
del Historial: fecha, horas de inicio y fin, parada en minutos, estado de la medición,
número de actividades omitidas y quién la registró. La parada total incluye también el tiempo
transcurrido en omisiones e incidencias. El CSV conserva el desglose por entrada,
incluidas incidencias, omisiones y correcciones.

## API

- `GET /api/auth/status`: estado de configuración y sesión, con el rol del usuario.
- El operario puede usar `GET /api/config` y `POST /api/records` (solo mediciones nuevas o
  propias, de origen Planta o Demo). El resto de rutas son del analista; el operario recibe 403.
- `POST /api/auth/setup`, `/api/auth/login`, `/api/auth/logout`: acceso. El inicio de sesión
  acepta `role` (`analista` u `operario`) y responde 401 si la cuenta es de otro rol. Al
  iniciar sesión se cierra la sesión anterior del mismo navegador.
- `GET /api/records`: historial.
- `POST /api/records`: guardar o corregir una medición. `_version` evita sobrescribir
  cambios de otra sesión; los reintentos del mismo registro no lo duplican.
- `DELETE /api/records/{id}`: borrar una medición.
- `POST /api/records/import`: importar identificadores que todavía no existen.
- `POST /api/records/seed`: renovar únicamente los registros simulados.
- `GET /api/config`, `POST /api/config`: configuración compartida.

## Alcance

Este servidor está pensado para uso local o una prueba en planta. GitHub almacena
el código; no ejecuta el backend. Para acceso por Internet se necesita un host con
Python, disco persistente y HTTPS; con HTTPS establece `SMED_SECURE_COOKIE=1`.
Los accesos de revisión se configuran al iniciar la instalación. No hay registro público de
más usuarios, recuperación de contraseña por correo ni despliegue automático.
