# Sorteo IG verificable

Herramientas para hacer un sorteo entre los comentarios de un reel de Instagram **que cualquiera pueda verificar**: la lista de participantes se publica de antemano con su huella (SHA-256) y con fechas que no controla el organizador; el número al azar lo publica un servicio independiente ([drand](https://drand.love), League of Entropy) en una ronda anunciada antes; y un algoritmo de 40 líneas da siempre el mismo resultado —y el mismo **código del sorteo**— con la misma lista y la misma ronda. No hay botón de "sortear de nuevo".

Páginas en GitHub Pages (`https://xdapx.github.io/sorteo-ig-comentarios/`):

| Página | Para quién | Qué hace |
|---|---|---|
| `sortear.html` | El organizador, en el vivo | Cuenta regresiva hasta la ronda, botón **Sortear**, animación, ganadores y suplentes con link a su comentario, y el **código del sorteo** para publicar. |
| `verificar.html` | Cualquiera | Muestra la lista y su huella (recalculada en el navegador), **cuándo se publicó** (fechas de GitHub Pages e Internet Archive, link al anuncio), consulta la ronda en drand, **rehace el sorteo** y calcula el código. Quien pega el código publicado ve si coincide. Buscador "¿estás en la lista?" y puesto de cada uno. |
| `index.html` | El organizador | Baja los comentarios del reel con la API de Meta (el token va del navegador a Meta, no pasa por ningún servidor). |

`ganadores.html` (la página vieja) redirige a `verificar.html`.

## Qué garantiza y cómo

| Riesgo en un sorteo común | Cómo se cubre acá |
|---|---|
| "Eligieron a un amigo" | El número al azar lo publica drand en la ronda anunciada; nadie lo conoce antes de ese segundo y no se puede cambiar. |
| "Tiraron de nuevo hasta que salió quien querían" | Misma lista + misma ronda = mismo resultado y mismo código, siempre. |
| "Metieron o sacaron gente de la lista después" | La lista se publica antes con su huella. **La prueba de "antes" no es el historial de git** (esas fechas las escribe quien commitea): son la fecha del deploy de GitHub Pages (la pone GitHub), la captura en Internet Archive y el anuncio en Instagram. `verificar.html` las muestra y las compara con la hora de la ronda. |
| "Eligieron la ronda después de ver cuál convenía" | La ronda sale solo de la fecha y hora anunciadas (minuto en punto); `preparar.js` no acepta rondas pasadas ni a menos de 1 hora; si sorteo.json no coincide con la fecha, las páginas bloquean el sorteo. |
| "Metieron cuentas que nunca comentaron" | `evidencia.json` publica el id y la fecha del comentario con el que entró cada participante; cada ganador linkea a su comentario en el reel. Regla pública: la cuenta ganadora tiene que tener ese comentario. |
| "Los que comentan 500 veces tienen más chances" | Una entrada por usuario. |
| "Filtraron la lista a dedo" (criterio `--menos-likes`) | `likes.json` publica los likes de **todos** los comentarios al momento del corte. Cualquiera saca de ahí cuál era el mínimo y quiénes lo tenían, y `node verificar.js` corta con error si el padrón no es exactamente ese conjunto. |
| "El resultado que publicaron no es el que salió" | El **código del sorteo** = `SHA-256(huella|cadena|ronda|semilla|ganadores|suplentes)`. Quien rehace el sorteo obtiene el mismo código. |
| "Después descalifican a quien quieren" | Requisitos y regla de reemplazo publicados antes en `sorteo.json`; el reemplazo es el siguiente suplente **en orden**, con motivo público. |
| "No entiendo cómo se eligió" | La página lo explica en 5 pasos; `node verificar.js` y `python verificar.py` lo reproducen (independientes entre sí) y cortan con error si algo no cierra. |

Lo que **no** se verifica: la firma BLS de la ronda de drand (se exige que varios espejos coincidan y que `randomness = SHA-256(firma)`; la firma la verifica un cliente de drand). Y que la lista sea completa respecto de Instagram: el CSV con los textos no se publica (privacidad), pero su SHA-256 queda en `sorteo.json` y se entrega a pedido.

## Runbook: hacer un sorteo

**Antes que nada:** anunciar en el reel hasta cuándo se puede comentar y el día y hora del sorteo (minuto en punto, hora Argentina).

1. **Bajar los comentarios** después del cierre, con `index.html` en el navegador o por línea de comandos:
   ```
   python sorteo_ig.py --token EAAG... --reel https://www.instagram.com/reel/XXXXX/
   ```
   Resuelve el Media ID solo, retoma si se corta y deja `comentarios.csv` (no se sube al repo). El token del Graph API Explorer dura 1-2 h: ver [`instrucciones_sorteo_ig.md`](instrucciones_sorteo_ig.md).
2. **Editar `sorteo.json`:** `titulo`, `premio`, `reel`, `ganadores`, `suplentes`, `requisitos` (lista de textos, ej. "seguir a @damiancivale", "responder el mensaje en 48 h"), `reemplazos`.
3. **Armar el padrón y fijar la ronda** (al menos 24 h antes del sorteo; nunca menos de 1 h):
   ```
   node preparar.js --csv comentarios.csv --fecha "2026-09-05T20:00:00-03:00" --excluir damiancivale
   ```
   Opciones: `--menos-likes` (**el criterio que se anunció en el reel del Alpine**: entran solo los comentarios con la menor cantidad de likes que haya en el reel al corte, casi siempre 0; publica `likes.json` con los likes de todos), `--mencion` (solo los que etiquetaron a alguien), `--reel URL`, `--media ID`. Escribe `participantes.json`, `evidencia.json` y actualiza `sorteo.json` (huella, ronda, hash del CSV). Imprime la huella corta para el anuncio. `--forzar` es solo para pruebas locales: marca la configuración como PRUEBA y las páginas lo muestran.
4. **Publicar:** `git add participantes.json evidencia.json likes.json sorteo.json && git commit -m "Padrón del sorteo" && git push`. Esperar el deploy y abrir `verificar.html`: tiene que decir "coincide" y, en "¿Cuándo se publicó la lista?", la fecha de GitHub Pages en verde. La CDN de Pages cachea 10 minutos: no anunciar hasta verlo.
5. **Captura externa:** `node anclar.js --wayback` (pide a Internet Archive una copia con fecha de la lista y de la configuración y las guarda en `sorteo.json`). Commitear y pushear `sorteo.json`.
6. **Anunciar en Instagram**, en algo permanente (posteo, o comentario fijado del organizador en el reel; una historia dura 24 h): link a `verificar.html`, cantidad de participantes, quiénes no participan, la ronda `#…` y la huella corta (`preparar.js` la imprime; la completa está en la página). Después `node anclar.js --anuncio <URL del posteo>`, commitear y pushear.
7. **Sortear:** a la hora anunciada abrir `sortear.html` (con la barra de dirección visible si es en vivo) y tocar **Sortear**. Publicar ganadores, suplentes y el **código del sorteo** ("Copiar resultado" arma el texto, con el link `verificar.html?codigo=…`).
8. Cualquiera que abra `verificar.html` después ve el mismo resultado y el mismo código. Si un ganador no cumple los requisitos, pasa al siguiente suplente en orden y se publica el motivo.

Si a la hora del sorteo drand no responde desde el navegador, la página distingue "la ronda todavía no salió" de "sin conexión" y reintenta. La ronda queda publicada para siempre: se puede sortear más tarde con la misma ronda, o pegar la `randomness` con `?semilla=` (queda marcado como manual).

## Definiciones exactas (para reproducir sin leer el código)

- **usuario**: el string tal cual figura en `participantes.json` (minúsculas, sin `@`, solo `[a-z0-9._]`, 1 a 30 caracteres, sin repetidos).
- **padrón con `--menos-likes`**: `minLikes` = la menor cantidad de likes entre todos los comentarios del reel al corte, sin contar los de los usuarios excluidos. Entra al padrón todo usuario que tenga **al menos un** comentario con exactamente `minLikes` likes, una sola vez. El comentario que se publica como evidencia es el más antiguo de los suyos que cumple. `likes.json` trae `[id, usuario, likes, fecha]` de cada comentario; su huella es SHA-256 de `id\tusuario\tlikes\tfecha\n` por fila, en el orden del archivo.
- **huella** de la lista: SHA-256 (hex) de los bytes UTF-8 de cada usuario seguido de `\n`, concatenados en el orden del archivo. `jq -r '.usuarios[]' participantes.json | sha256sum`.
- **ronda**: `floor((t − 1692803367) / 3) + 1`, con `t` la fecha del sorteo en epoch (segundos). Cadena drand `quicknet` (`52db9ba7…c84e971`); genesis y período en `https://api.drand.sh/<hash>/info`.
- **semilla**: campo `randomness` de esa ronda, 64 hex en minúscula, usada como texto.
- **puntaje**: SHA-256 (hex) de los bytes UTF-8 de `semilla + ":" + usuario`. Orden ascendente por puntaje (como texto hex); desempate por usuario ascendente. Ganadores = primeros N; suplentes = siguientes M.
- **código del sorteo**: SHA-256 de `huella|cadena|ronda|semilla|ganador1,ganador2,…|suplente1,suplente2,…`.
- **huella de la evidencia**: SHA-256 de `usuario\tid\ttimestamp\n` por cada usuario, en el orden de la lista.

## Archivos

| Archivo | Qué es |
|---|---|
| `sortear.html`, `verificar.html` | Las dos páginas. Comparten `sorteo.css`, `sorteo-core.js` y `sorteo-ui.js`. |
| `sorteo-core.js` | El algoritmo, la fórmula de la ronda, la consulta a drand, el código del sorteo y las anclas. Corre en el navegador y en Node. |
| `preparar.js` | CSV → `participantes.json` + `evidencia.json` + huella y ronda en `sorteo.json`. Rechaza fechas pasadas, sin zona horaria o con segundos. |
| `anclar.js` | Guarda en `sorteo.json` la captura de Internet Archive (`--wayback`) y el link del anuncio (`--anuncio`). |
| `verificar.js` / `verificar.py` | Reproducen el sorteo desde cero y cortan con error si algo no cierra. `--semilla <hex>`, `--codigo <hex>`, `--usuario x` (Node). |
| `sorteo.json` | Configuración: título, premio, reel, N/M, requisitos, fecha, ronda, huellas, anclas, `pages` (URL pública), `prueba`. |
| `participantes.json` | Padrón publicado: usuarios únicos + metadatos (reel, corte, criterio, huella). |
| `evidencia.json` | Id y fecha del comentario con el que entró cada participante, con su huella y el SHA-256 del CSV. |
| `likes.json` | Solo con `--menos-likes`: los likes de **todos** los comentarios al corte (sin los textos). Es lo que permite comprobar el filtro. |
| `mas-likes.txt` | Solo con `--menos-likes`: los 50 comentarios con más likes, para elegir a mano el premio al más creativo. **No se publica** (está en `.gitignore`). |
| `index.html` / `sorteo_ig.py` | Descarga de comentarios por la API de Meta (ver [`instrucciones_sorteo_ig.md`](instrucciones_sorteo_ig.md) para el token). |

## Datos personales

`participantes.json` y `evidencia.json` publican **solo nombres de usuario, ids y fechas de comentarios públicos** en un reel público; es lo mínimo para que cada uno pueda comprobar que está en la lista y que los ganadores comentaron. Los textos de los comentarios quedan en `comentarios.csv`, que está en `.gitignore` y no se sube.
