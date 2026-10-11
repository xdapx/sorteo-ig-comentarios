# El token de Meta para bajar los comentarios

Instructivo para el dueño de la cuenta (Damián), en página aparte y escrita para él:
**https://claude.ai/code/artifact/1918a4a2-27d2-44d0-9bb4-94322a90b4a6**

Este archivo es la referencia técnica: por qué cada cosa es como es. Verificado contra la
documentación de Meta el **31/08/2026**.

## Lo que hay que pedir

Token de **usuario** de Facebook, generado en el [Graph API Explorer](https://developers.facebook.com/tools/explorer),
con estos cuatro permisos:

```
instagram_basic  instagram_manage_comments  pages_show_list  pages_read_engagement
```

**Los cuatro son el mínimo, no se puede pedir menos.** `instagram_manage_comments` no es
opcional aunque solo queramos leer: desde el 27/08/2024 el campo `username` del comentario
no se devuelve sin él, y sin username no hay ganador identificable.

## Las cinco cosas que hacen fallar esto

1. **La tarea sobre la Página.** `instagram_manage_comments` solo lo puede otorgar alguien
   que tenga la tarea **Actividad de la comunidad** (`PROFILE_PLUS_MODERATE`) sobre la Página
   vinculada a la cuenta. Si el acceso vino por un portafolio de Business Manager con solo
   Anuncios o Contenido, el permiso no sale nunca — el token se genera igual pero el GET de
   comentarios devuelve error. Curiosamente la tabla oficial no lista ese permiso en la fila
   "Control total". Síntoma: se regenera el token tres veces y pasa lo mismo.
2. **Las pantallas del popup.** Al generar el token, Facebook pregunta en pantallas separadas
   qué Páginas y qué cuentas de Instagram incluir. Si queda una sin tildar, el token sale pero
   no sirve. Es el error más común.
3. **El Explorer necesita una app.** No existe una app genérica: hace falta cuenta de
   desarrollador y una app donde la persona tenga rol. La frase de la doc *"you can use the
   Graph API Explorer instead and skip steps 1 and 2"* NO significa saltear la creación de la app
   (los pasos 1 y 2 son configurar e implementar Facebook Login).
4. **El caso de uso del asistente.** Si se crea la app eligiendo un caso de uso de Instagram,
   Meta agrega los permisos `instagram_business_*` del otro camino (Instagram Login, host
   `graph.instagram.com`) y los cuatro de arriba no aparecen en el desplegable. Hay que elegir
   **Otro**.
5. **No hace falta App Review ni verificación de negocio.** Con Acceso Estándar y la app en
   modo desarrollo alcanza, siempre que quien genera el token tenga rol en la app.

## Límites reales del endpoint

`GET /{ig-media-id}/comments?fields=id,username,text,like_count,timestamp`

- **Máximo 50 comentarios por página**, aunque se pida `limit=100`. `sorteo_ig.py` pide 50.
- **Solo comentarios de primer nivel.** Las respuestas a otros comentarios NO vienen (habría
  que pedirlas con expansión del campo `replies`). Esto se avisa en el anuncio del sorteo.
- **Los comentarios de cuentas restringidas por el dueño no se devuelven**, y no hay forma de
  saberlo desde los datos. Por eso el contador de comentarios que muestra Instagram nunca va a
  coincidir con el CSV: no sirve como control de integridad. El control válido es que la última
  página venga sin cursor `after`.
- Orden cronológico inverso. No se puede filtrar por fecha.
- Rate limit por caso de uso: `4800 × impresiones de las últimas 24 h`, en ventana móvil de
  24 h. Al pasarse llega el código 80002 y el header `X-Business-Use-Case-Usage` dice cuántos
  minutos faltan para recuperar acceso. El script ya espera y reintenta.

**`like_count` devuelve valores reales de comentarios ajenos**: verificado con el CSV de julio
de 2026 (24.848 comentarios bajados por este mismo endpoint, con 599 en cero, 1.347 en uno y
4.301 en tres). La documentación no lo garantiza explícitamente, así que si alguna vez vinieran
todos en cero, el criterio "menos likes" se queda sin dato — se comprueba con una sola llamada
de 5 comentarios antes de la corrida larga.

## Versión de la API

`sorteo_ig.py` usa **v21.0**, que es con la que se bajó el reel de julio y sigue soportada
(vence el 21/01/2027). La vigente hoy es v26.0 y los ejemplos de la doc usan v25.0. Si Meta
rechazara la versión: `python sorteo_ig.py --version v25.0 ...`.

## Duración del token y seguridad

Dura **una o dos horas** y Meta avisa que ese plazo puede cambiar sin aviso. El valor real de
ese token se lee con `GET /debug_token` (campo `expires_at`), no se adivina.

Con 4.700 comentarios la descarga son minutos, así que **no hace falta canjearlo por uno largo**.
Si alguna vez hiciera falta (reel de 100 mil comentarios), el canje es
`GET /oauth/access_token?grant_type=fb_exchange_token&client_id=…&client_secret=…&fb_exchange_token=…`
y dura ~60 días — pero expone el **App Secret**, así que lo corre el dueño de la app desde su
máquina, nunca el dueño de la cuenta de Instagram y nunca desde el navegador.

**Qué puede hacer quien tenga ese token** (esto va dicho antes de pedirlo, no después):
leer comentarios con su autor y sus likes; **responder, ocultar y borrar comentarios**; apagar
los comentarios de cualquier publicación; leer datos ya públicos del perfil y la lista de
publicaciones. **No** puede publicar posteos ni historias, **no** puede borrar publicaciones,
**no** puede leer mensajes privados, **no** puede ver estadísticas privadas, **no** puede tocar
el perfil y **no** es la contraseña.

Se revoca desde Facebook: Configuración y privacidad → Configuración → Apps y sitios web →
eliminar la app.

## Para la próxima: sacar al cliente de la consola

El camino más corto no es este. Si la app la crea y administra Vesl, se le puede mandar al
dueño de la cuenta **un solo link** de OAuth con los permisos ya adentro
(`https://www.facebook.com/v26.0/dialog/oauth?client_id=…&redirect_uri=https://www.facebook.com/connect/login_success.html&response_type=token%20granted_scopes&scope=…`):
él lo abre, tilda todo y copia la URL de la barra, que trae el token y los permisos concedidos.
No necesita cuenta de desarrollador si se lo agrega como **Evaluador** de la app. Requiere
registrar ese `redirect_uri` una vez y probar el link con la cuenta propia antes de mandarlo.
