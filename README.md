# SMED · Troqueladora

Aplicación para registrar el tiempo total de setup y la duración de sus actividades.
Incluye acceso por rol (analista y operario), actividades editables, repeticiones, omisiones,
correcciones, historial y análisis con exportación a CSV y Excel.

## Usuarios y roles

| Rol | Usuario | Opciones |
|---|---|---|
| Analista | `usuario` | Nuevo setup con preparación externa, Historial, Análisis y Configuración. |
| Operario | `operario` | Nuevo setup con preparación externa, sin editar la lista de actividades. |

En el servidor local las contraseñas de revisión son `artefacto` (analista) y
`troqueladora` (operario). La aplicación publicada usa otras contraseñas, que no están
en el repositorio ni en la pantalla: se entregan aparte a cada rol.

Al entrar se elige primero **Ingresar como analista** o **Ingresar como operario**; después
aparece el formulario con las credenciales de ese rol a la derecha. El servidor rechaza las
credenciales de un rol distinto al elegido.

Cada rol ve únicamente sus secciones. El servidor también lo exige: el operario solo
puede leer la configuración y guardar o corregir las mediciones que él registró; el
historial, el análisis y los demás cambios responden 403. Al finalizar un setup, el
operario vuelve a preparar el siguiente y el analista ve la medición en el Historial.

## Aplicación publicada en GitHub Pages

https://alejandro-castillo-eng.github.io/smed-troqueladora/

La versión publicada guarda las mediciones en una base de datos compartida de
**Supabase** (proyecto `smed-troqueladora`, región São Paulo). Lo que registra el
operario en la planta lo ve el analista desde cualquier equipo, en Historial y Análisis,
y se puede exportar a Excel. La sesión dura 12 horas y se conserva al recargar.

El workflow `Publicar aplicación en GitHub Pages` publica automáticamente al cambiar
la rama `main`. El script `scripts/build_pages.py` toma `index.html`, le añade
`scripts/supabase-adapter.js` y quita el recuadro de credenciales.

### Cómo se protege la base de datos

- Las tablas están en el esquema privado `smed`, que la API de Supabase no expone. La
  clave publicable que va en la página no permite leerlas ni modificarlas.
- La página solo puede llamar a las funciones `public.smed_*`
  (`supabase/migrations/20261103000000_smed.sql`). Cada una revisa la sesión y el rol con
  las mismas reglas que `server.py`: el operario lee la meta y guarda o corrige sus
  propias mediciones; el historial, el análisis, la configuración y los borrados son
  del analista.
- Las contraseñas se guardan con bcrypt y las sesiones como hash SHA-256 del token.
  Tras 10 intentos fallidos en 15 minutos, ese usuario queda bloqueado 15 minutos.

### Cambiar una contraseña

En el panel de Supabase, **SQL Editor**:

```sql
update smed.users set password_hash = extensions.crypt('NuevaClave123', extensions.gen_salt('bf', 10))
 where username = 'operario';
delete from smed.sessions where user_id = (select id from smed.users where username = 'operario');
```

### Plan gratuito

Supabase pausa los proyectos gratuitos después de 7 días sin actividad. Los datos no
se pierden: se reactiva desde el panel de Supabase con **Restore project**. Mientras
esté pausado, la página muestra un error de conexión al iniciar sesión.

## Ejecutar el backend local

Requiere Python 3.10 o posterior. No hay paquetes que instalar.

```powershell
python server.py
```

Abre http://127.0.0.1:8080. Los accesos de revisión del analista y del operario
(ver la tabla de roles) se muestran junto al inicio de sesión para facilitar la
revisión del profesor. La autenticación se valida en el servidor, con contraseña
derivada mediante PBKDF2 y sesión en cookie HttpOnly.

## Preparación externa

En **Preparar la medición** el operario y el analista marcan, con la máquina todavía
produciendo, dos grupos, cada uno con su avance:

- **Materiales y herramientas a la mano (6):** troquel verificado, láminas en el carrito,
  herramientas de ajuste, plantilla, ficha técnica y lugar libre para el troquel que se retira.
- **Actividades hechas con la máquina en marcha (5):** revisar la orden, inspeccionar y limpiar
  el troquel nuevo, ordenar la zona, anotar presión, velocidad y registro, y avisar a calidad
  para aprobar la primera pieza. Buscan acortar las actividades más largas de la parada.

Las marcas se conservan al recargar. La parada se inicia aunque falten puntos, sin preguntas:
la medición guarda, por grupo, cuántos estaban listos y cuáles faltaban, y el resultado lo muestra.

El operario no ve la lista editable de actividades para no distraerse durante el cambio:
marca la preparación externa, presiona **Iniciar parada y medición** (arriba, en la misma
tarjeta) y, al acabar,
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

En el servidor local, el primer arranque genera **24 registros identificados como Simulado**,
repartidos entre varios días y horas. Incluyen actividades normales, repeticiones
y omisiones. Son ejemplos inventados, no mediciones reales de planta. La versión publicada
empieza vacía, para que solo contenga mediciones reales; el analista puede cargar los
ejemplos con **Restablecer registros simulados** en Configuración.

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

La medición, la exportación Excel, las pantallas de cada rol y el adaptador de Supabase se comprueban con
Node.js 18 o posterior, sin instalar paquetes:

```sh
node --test test_excel_export.cjs test_measurement.cjs test_access.cjs test_supabase_adapter.cjs
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
  acepta `role` (`analista` u `operario`) y responde 401 si la cuenta es de otro rol.
- `GET /api/records`: historial.
- `POST /api/records`: guardar o corregir una medición. `_version` evita sobrescribir
  cambios de otra sesión; los reintentos del mismo registro no lo duplican.
- `DELETE /api/records/{id}`: borrar una medición.
- `POST /api/records/import`: importar identificadores que todavía no existen.
- `POST /api/records/seed`: renovar únicamente los registros simulados.
- `GET /api/config`, `POST /api/config`: configuración compartida.

## Alcance

`server.py` está pensado para uso local o una prueba en planta. Para el acceso por
Internet se usa la versión publicada en GitHub Pages con Supabase. Si se quisiera alojar
`server.py`, se necesita un host con Python, disco persistente y HTTPS; con HTTPS
establece `SMED_SECURE_COOKIE=1`.
Los accesos de revisión se configuran al iniciar la instalación. No hay registro público de
más usuarios ni recuperación de contraseña por correo.
