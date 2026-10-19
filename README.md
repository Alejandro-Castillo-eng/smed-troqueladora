# SMED · Troqueladora

Aplicación para registrar el tiempo total de setup y la duración de sus actividades.
Incluye acceso del supervisor, actividades editables, repeticiones, omisiones,
correcciones, historial y análisis con exportación a CSV y Excel.

## Aplicación publicada en GitHub Pages

https://alejandro-castillo-eng.github.io/smed-troqueladora/

Usuario: **usuario** · Contraseña: **artefacto**.

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

Abre http://127.0.0.1:8080. El acceso de revisión es **usuario: `usuario`** y
**contraseña: `artefacto`**. También se muestran junto al inicio de sesión para
facilitar la revisión del profesor. La autenticación se valida en el servidor,
con contraseña derivada mediante PBKDF2 y sesión en cookie HttpOnly.

## Almacenamiento

SQLite guarda las mediciones, correcciones, configuración y cuenta en
`data/smed.sqlite3`. Los borradores de la medición en curso permanecen en el navegador.
Al acceder se importan una sola vez los registros del prototipo anterior si existen
allí; los identificadores existentes no se sobrescriben.

Para hacer una copia, detén el servidor y copia la carpeta `data`. La base de datos,
sus usuarios y sesiones **no se suben a GitHub**.

## Datos de ejemplo

En el primer arranque se generan **24 registros identificados como Simulado**,
repartidos entre varios días y horas. Incluyen actividades normales, repeticiones
y omisiones. Son ejemplos inventados, no mediciones reales de planta.

El análisis permite elegir Planta, Simulado o Piloto. Los datos Demo se excluyen;
las mediciones con omisiones se conservan en el historial y su detalle. El promedio
por actividad utiliza las mediciones completas. El botón para restablecer simulados
renueva solo estos ejemplos y conserva las mediciones de planta y piloto.

## Pruebas

```powershell
python -m unittest test_backend -v
```

Las pruebas utilizan una base temporal y verifican acceso, persistencia, validación,
importación, correcciones concurrentes, guardado idempotente y renovación de ejemplos.

La exportación Excel se comprueba con Node.js 18 o posterior, sin instalar paquetes:

```sh
node --test test_excel_export.cjs
```

## Exportar Excel

Desde Historial, **Exportar Excel** descarga todas las mediciones guardadas.
La hoja **Mediciones** contiene una fila por setup: primero la fecha y después una
columna por actividad, con número, nombre y duración en minutos. Reúne las actividades
de todos los planes exportados y las numera en su orden de aparición; los nombres
iguales comparten columna aunque cambien de posición o identificador entre planes.
Las repeticiones registradas se suman y las actividades ausentes u omitidas muestran
**No se registró**. Un tiempo registrado de cero se conserva como número.

Al final aparecen las horas, el origen y la parada total. La hoja **Detalle** conserva
el desglose por entrada, incluidas incidencias, omisiones y correcciones. La parada
total incluye también el tiempo transcurrido en omisiones e incidencias.

## API

- `GET /api/auth/status`: estado de configuración y sesión.
- `POST /api/auth/setup`, `/api/auth/login`, `/api/auth/logout`: acceso.
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
El acceso de revisión se configura al iniciar la instalación. No hay registro público de
más usuarios, recuperación de contraseña por correo ni despliegue automático.
