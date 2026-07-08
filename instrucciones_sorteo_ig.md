# Instructivo completo: extraer comentarios de Instagram y encontrar el de MENOS likes

Reel del sorteo: https://www.instagram.com/reel/DaV38Tqswr3/ (cuenta **@damiancivale**, ~119 mil comentarios)

**Importante:** por el volumen (119 mil comentarios), esto solo se puede hacer con la API oficial de Meta. Contar a mano o mirar la app no sirve. Necesitás ser **admin de la cuenta @damiancivale** (o que el admin haga estos pasos), porque el token solo da acceso a los datos de la propia cuenta.

Todo esto lo hace la persona dueña/admin de @damiancivale, sin necesidad de saber programar (son todo clicks, salvo el último paso que es correr un script ya armado).

---

## Paso 0 — Requisito: cuenta profesional vinculada a Facebook
1. Abrir Instagram → Perfil → tocar el ícono de menú (☰) → **Configuración y privacidad**
2. Ir a **Cuenta** → **Tipo de cuenta y herramientas** → verificar que diga **Business** o **Creator** (si dice "Personal", cambiarla ahí mismo)
3. Ir a **Configuración → Cuenta → Cuentas vinculadas** → conectar/verificar que esté vinculada a una **Página de Facebook** (si no existe la página, Instagram ofrece crearla automáticamente en este paso)

Sin esto, ninguno de los pasos siguientes va a funcionar.

---

## Paso 1 — Crear una app en Meta for Developers (gratis, 2 minutos)
1. Entrar a https://developers.facebook.com/apps con la cuenta de Facebook que administra la Página
2. Botón **"Crear app"**
3. Tipo de app: elegir **"Otro"** → siguiente → **"Empresa"** (o "Ninguno", cualquiera sirve)
4. Ponerle un nombre (ej: "Sorteo Reel") y crear
5. Quedará en el **Panel de la app** — de ahí sacamos dos datos que vamos a necesitar después: **App ID** y **App Secret** (están en Configuración → Básica del menú izquierdo). Anotarlos.

---

## Paso 2 — Generar el Access Token (Graph API Explorer)
1. Ir a https://developers.facebook.com/tools/explorer
2. Arriba a la derecha, en el selector de app, elegir la app creada en el Paso 1
3. En "User or Page", dejar **User Token**
4. Click en el botón de permisos (o "Add a Permission") y tildar:
   - `instagram_basic`
   - `pages_show_list`
   - `pages_read_engagement`
5. Click **"Generate Access Token"** → se abre un login de Facebook → aceptar los permisos con la cuenta que administra la Página de @damiancivale
6. Copiar el token largo que aparece en el cuadro de texto de arriba (dura solo 1-2 horas)

### Paso 2.1 — Extenderlo a token de larga duración (60 días)
Como el proceso con 119 mil comentarios puede tardar y convenir reintentar sin repetir todo, conviene canjear ese token corto por uno largo. En la misma página del Explorer, en el campo GET pegar esta URL completa (reemplazando los 4 valores en MAYÚSCULA por los datos propios: App ID y App Secret del Paso 1, y el token corto del Paso 2):

```
https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=TOKEN_CORTO
```

Esto se puede pegar directo en la barra de direcciones del navegador (no hace falta el Explorer para este paso). Devuelve un JSON con un `access_token` nuevo que dura ~60 días. **Ese es el que vamos a usar en el script.**

---

## Paso 3 — Obtener el Page ID
De vuelta en el Graph API Explorer, en el campo GET escribir:
```
me/accounts
```
→ Submit. Devuelve una lista de páginas administradas; copiar el `id` de la Página vinculada a @damiancivale.

## Paso 4 — Obtener el Instagram User ID
Reemplazando `PAGE_ID`:
```
PAGE_ID?fields=instagram_business_account
```
Devuelve `{"instagram_business_account": {"id": "..."}}`. Ese `id` es el **IG User ID**.

## Paso 5 — Obtener el Media ID del reel
Reemplazando `IG_USER_ID`:
```
IG_USER_ID/media?fields=id,caption,permalink&limit=25
```
Buscar en los resultados el que tenga `DaV38Tqswr3` en el `permalink`. Copiar su `id` — ese es el **MEDIA_ID**.

> Si el reel es viejo y no aparece en los primeros 25, agregar `&limit=100`, o repetir la consulta con el cursor `after` que trae la respuesta en `paging.next`.

---

## Paso 6 — Correr el script que extrae y ordena los comentarios
Con el **Access Token largo** (Paso 2.1) y el **Media ID** (Paso 5), completar esos dos valores en el archivo `sorteo_ig.py` y correr:
```
pip install requests
python sorteo_ig.py
```

Con 119 mil comentarios el proceso tarda bastante (son ~1.200 páginas de 100 comentarios cada una). El script:
- Guarda el progreso en un CSV (`comentarios.csv`) a medida que avanza, así si se corta a mitad de camino no se pierde lo ya bajado
- Si Meta devuelve error de límite de uso (código 429 o mensaje de rate limit), espera y reintenta solo automáticamente
- Al terminar, muestra el/los comentarios con menos likes

---

## Resumen de lo que hay que mandar
Al final, lo único que necesito para correr el sorteo es:
1. El **Access Token largo** (Paso 2.1)
2. El **Media ID** (Paso 5)

### Nota de seguridad
El token no es contraseña ni permite publicar/borrar nada — solo lee datos públicos de la propia cuenta. Aun así, no compartirlo en grupos ni redes, solo en un canal privado y de confianza.
