"""
Trae todos los comentarios de un posteo de Instagram (cuenta Business/Creator)
con su cantidad de likes y los guarda en comentarios.csv.

Este script SOLO descarga. El sorteo se hace aparte, de forma verificable:
    node preparar.js --csv comentarios.csv --fecha "AAAA-MM-DDTHH:MM:SS-03:00"
y despues sortear.html / verificar.html (ver README.md).

Pensado para volumenes grandes (cientos de miles de comentarios):
  - Guarda progreso en comentarios.csv a medida que avanza.
  - Guarda el CURSOR de paginacion en estado_sorteo.json, asi si se corta
    retoma desde donde iba (NO vuelve a descargar todo desde el principio,
    que quemaria la cuota de la API).
  - Distingue rate limit (espera y reintenta) de errores permanentes como
    token vencido o media invalido (frena y muestra el error real de Meta).

Uso:
    pip install requests
    python sorteo_ig.py --token EAAG... --reel https://www.instagram.com/reel/Dbe0kXLgFfk/
    python sorteo_ig.py --token EAAG... --media 178123...      (si ya se sabe el Media ID)
    python sorteo_ig.py --token EAAG... --media 178... --reset (empezar de cero, borra el progreso)

Tambien se pueden dejar fijos ACCESS_TOKEN y MEDIA_ID abajo, pero los argumentos mandan.
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from urllib.parse import parse_qs, parse_qsl, urlencode, urlparse, urlsplit, urlunsplit

import requests

ACCESS_TOKEN = "PEGAR_ACA_EL_TOKEN"
MEDIA_ID = "PEGAR_ACA_EL_MEDIA_ID"


# v21.0 es la version con la que ya se bajo este reel en julio de 2026 y sigue soportada (vence 21/01/2027).
# Si Meta la rechaza, correr con --version v25.0 (la que usan hoy los ejemplos de la doc).
VERSION = "v21.0"
GRAPH_URL = "https://graph.facebook.com/" + VERSION
CSV_PATH = "comentarios.csv"
ESTADO_PATH = "estado_sorteo.json"
# respuesta_a: vacio si es un comentario de primer nivel; el id del comentario padre si es
# una respuesta dentro de un hilo. Para quien contesta, sigue siendo un comentario en el video.
CAMPOS = ["id", "username", "text", "like_count", "timestamp", "respuesta_a"]

MAX_REINTENTOS = 6
BACKOFF_MAX = 1200  # tope de espera entre reintentos, en segundos (20 min)


# --------------------------- progreso / estado ---------------------------

def cargar_progreso():
    """Lee el CSV de una corrida anterior (si existe) para no re-guardar lo ya bajado."""
    if not os.path.exists(CSV_PATH):
        return [], set()

    comentarios = []
    ids_vistos = set()
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        for fila in csv.DictReader(f):
            fila["like_count"] = int(fila.get("like_count") or 0)
            comentarios.append(fila)
            ids_vistos.add(fila["id"])
    return comentarios, ids_vistos


def cargar_estado():
    if not os.path.exists(ESTADO_PATH):
        return {}
    try:
        with open(ESTADO_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def guardar_estado(estado):
    with open(ESTADO_PATH, "w", encoding="utf-8") as f:
        json.dump(estado, f)


def reescribir_todo(comentarios):
    """Reescribe el CSV entero. Hace falta cuando cambian las columnas: un archivo viejo
    no tiene 'respuesta_a' y appendear filas con una columna de mas lo desalinea."""
    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CAMPOS)
        writer.writeheader()
        for c in comentarios:
            writer.writerow({k: (c.get(k) if c.get(k) is not None else "") for k in CAMPOS})


# --------------------------- pedidos a la API ---------------------------

def con_token_actual(url, token):
    """Cambia el access_token de una URL guardada por el de esta corrida."""
    partes = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(partes.query, keep_blank_values=True) if k != "access_token"]
    q.append(("access_token", token))
    return urlunsplit((partes.scheme, partes.netloc, partes.path, urlencode(q), partes.fragment))


def cursor_de_next(next_url):
    """Fallback: sacar el cursor 'after' de la URL 'paging.next' si hiciera falta."""
    if not next_url:
        return None
    valores = parse_qs(urlparse(next_url).query).get("after")
    return valores[0] if valores else None


def pedir_con_reintentos(url, params):
    """
    Hace el GET distinguiendo tres casos:
      - rate limit (429 o codigos 4/17/32/613): espera (respetando Retry-After) y reintenta.
      - error transitorio (500/502/503): backoff exponencial y reintenta.
      - error permanente (token vencido 190, media invalido, permisos, etc.):
        FRENA y muestra el mensaje real de Meta, en vez de reintentar a ciegas.
    """
    espera = 30
    for intento in range(1, MAX_REINTENTOS + 1):
        resp = requests.get(url, params=params, timeout=60)

        if resp.status_code == 200:
            return resp.json()

        try:
            err = resp.json().get("error", {})
        except ValueError:
            err = {}
        code = err.get("code")
        msg = err.get("message") or resp.text[:300]

        # Token vencido / invalido: no tiene sentido reintentar.
        if code == 190:
            raise RuntimeError(
                f"Token invalido o vencido (codigo 190). Meta dice: {msg}\n"
                "Genera un token nuevo (Paso 2 / 2.1 del instructivo), actualiza "
                "ACCESS_TOKEN y volve a correr: retoma desde donde iba."
            )

        es_rate_limit = resp.status_code == 429 or code in (4, 17, 32, 613, 80004)
        es_transitorio = resp.status_code in (500, 502, 503)

        if es_rate_limit:
            retry_after = resp.headers.get("Retry-After")
            pausa = int(retry_after) if (retry_after and retry_after.isdigit()) else espera
            print(f"  Rate limit de Instagram (codigo {code}). Espero {pausa}s y reintento "
                  f"({intento}/{MAX_REINTENTOS})...        ")
            time.sleep(pausa)
            espera = min(BACKOFF_MAX, espera * 2)
            continue

        if es_transitorio:
            print(f"  Error transitorio {resp.status_code}. Reintento {intento}/{MAX_REINTENTOS} "
                  f"en {espera}s...        ")
            time.sleep(espera)
            espera = min(BACKOFF_MAX, espera * 2)
            continue

        # Cualquier otro error (400/403/404 no-rate-limit): permanente.
        raise RuntimeError(f"Error {resp.status_code} de Meta (codigo {code}): {msg}")

    raise RuntimeError(
        f"No se pudo completar el pedido tras {MAX_REINTENTOS} reintentos (rate limit sostenido). "
        "El progreso quedo guardado: volve a correr mas tarde y retoma desde donde iba."
    )


def obtener_comentarios(media_id, token):
    estado = cargar_estado()
    comentarios_previos, ids_vistos = cargar_progreso()

    # No se corta por "ya lo baje una vez": cada corrida vuelve a barrer y ACUMULA por id, asi
    # entra lo que se comento desde la vez anterior y nunca se borra lo que ya se tenia.
    # (El 31/08/2026 se comprobo ademas que un comentario que deja de aparecer en el listado
    # sigue existiendo si se lo pide por su id, asi que lo acumulado no caduca.)
    if estado.get("completado") and comentarios_previos:
        print(f"Ya habia {len(comentarios_previos)} comentarios guardados. Vuelvo a pedir y acumulo "
              "(la API solo sirve los mas recientes: lo viejo ya no vuelve).")

    todos = list(comentarios_previos)
    # Indice por id para poder ACTUALIZAR lo que ya estaba, no solo agregar lo nuevo.
    por_id = {c["id"]: c for c in todos}
    if comentarios_previos:
        print(f"Retomo progreso: {len(comentarios_previos)} comentarios ya guardados"
              + (" (desde donde iba)." if estado.get("next") else "."))

    url = f"{GRAPH_URL}/{media_id}/comments"
    params = {
        # Las respuestas vienen por expansion en el mismo pedido: el edge /comments SOLO
        # devuelve comentarios de primer nivel, y para quien contesto adentro de un hilo su
        # respuesta es un comentario en el video igual.
        "fields": "id,text,username,like_count,timestamp,"
                  "replies.limit(200){id,text,username,like_count,timestamp}",
        "access_token": token,
        # La doc dice "maximo 50 por query" y NO es cierto: con limit=50 la paginacion se
        # atasca y corta en ~475 sin dar ningun error; con limit=500 trae los 2.901 reales.
        "limit": 500,
    }
    # Si una corrida anterior quedo A MITAD, se retoma con la URL 'next' que dio Meta.
    # Si termino, se arranca de cero otra vez: hay que volver a barrer la ventana entera para
    # levantar lo que entro desde entonces.
    # OJO: esa URL trae el access_token VIEJO embebido. Si se la usa tal cual despues de que
    # el token vencio, Meta contesta 190 y parece que el token nuevo no sirve.
    if estado.get("next") and not estado.get("completado"):
        url, params = con_token_actual(estado["next"], token), {}

    # IMPORTANTE: se sigue paging.next COMPLETO, no se rearma el pedido con el cursor 'after'.
    # La URL 'next' de Meta trae parametros propios (__paging_token y otros) que el cursor solo no
    # reemplaza: rearmando el pedido, la paginacion empieza a devolver paginas repetidas y se corta
    # a la decima parte de los comentarios. Asi lo hace index.html, que es como se bajaron los
    # 24.848 comentarios del reel de julio.
    cursores_vistos = set()
    actualizados = set()  # ids a los que les cambiaron los likes desde la corrida anterior
    while True:
        data = pedir_con_reintentos(url, params)

        # Cada comentario de primer nivel entra con respuesta_a vacio, y sus respuestas
        # entran como filas propias apuntando al id del padre.
        lote = []
        for c in data.get("data", []):
            c["respuesta_a"] = ""
            lote.append(c)
            for r in ((c.get("replies") or {}).get("data") or []):
                r["respuesta_a"] = c["id"]
                lote.append(r)
            c.pop("replies", None)

        # Los que ya estaban NO se saltean: se les pisan los likes con el valor de ahora.
        # Un comentario bajado hace tres semanas con 0 likes hoy puede tener 40, y si el
        # criterio del sorteo es "el que tiene menos likes", ese numero viejo elige mal al
        # ganador. Paso el 31/08/2026: @analita.fre figuraba con 0 y en Instagram tenia 4.
        lote_nuevo = []
        for c in lote:
            previo = por_id.get(c["id"])
            if previo is None:
                por_id[c["id"]] = c
                ids_vistos.add(c["id"])
                lote_nuevo.append(c)
                continue
            for k in CAMPOS:
                if k in c and c[k] != previo.get(k):
                    if k == "like_count":
                        actualizados.add(c["id"])
                    previo[k] = c[k]

        todos.extend(lote_nuevo)
        # Se reescribe el archivo entero en cada pagina, no se appendea. Appendear solo lo
        # nuevo dejaria en disco los likes viejos de las filas que se acaban de actualizar en
        # memoria, y si la corrida se corta (el token dura 1-2 h) se pierde el refresco entero.
        # Paso el 31/08/2026: vencio a mitad de barrido y se perdieron 149 actualizaciones.
        if lote_nuevo or actualizados:
            reescribir_todo(todos)

        # OJO: "pagina sin comentarios nuevos" NO es senal de que se atasco. En una corrida de
        # acumulacion TODAS las paginas vienen repetidas, porque ya se bajaron antes. La unica
        # senal real de atasco es que Meta devuelva DOS VECES el mismo cursor.

        print(f"  Progreso: {len(todos)} comentarios | {len(actualizados)} con los likes "
              f"cambiados...    ", end="\r")

        siguiente = (data.get("paging") or {}).get("next")
        if not siguiente:
            guardar_estado({"completado": True})
            break
        cursor = cursor_de_next(siguiente)
        if cursor and cursor in cursores_vistos:
            print()
            print("AVISO: Meta devolvio dos veces el mismo cursor de paginacion. CORTO ACA para no "
                  "girar en falso: lo bajado puede estar incompleto.")
            guardar_estado({"next": siguiente, "completado": False})
            break
        if cursor:
            cursores_vistos.add(cursor)

        guardar_estado({"next": siguiente, "completado": False})
        url, params = siguiente, {}

    # Reescritura final: hace falta si o si porque las filas viejas se editaron en memoria
    # (appendear solo lo nuevo dejaria los likes viejos en el archivo). De paso deja las
    # columnas actuales aunque venga de una corrida vieja con menos.
    reescribir_todo(todos)
    print()
    if actualizados:
        print(f"Le cambiaron los likes a {len(actualizados)} comentarios desde la corrida anterior.")
    return todos



def shortcode_de_reel(url):
    m = re.search(r"instagram\.com/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)", url or "")
    return m.group(1) if m else ""


def resolver_media_id(token, shortcode):
    """Igual que index.html: Pagina de FB -> cuenta IG -> buscar el permalink entre los posteos."""
    cuentas = pedir_con_reintentos(f"{GRAPH_URL}/me/accounts",
                                   {"access_token": token, "fields": "id,name,instagram_business_account", "limit": 100})
    paginas = cuentas.get("data", [])
    if not paginas:
        raise RuntimeError("El token no administra ninguna Pagina de Facebook (ver Paso 0 del instructivo).")

    for pagina in paginas:
        ig = (pagina.get("instagram_business_account") or {}).get("id")
        if not ig:
            info = pedir_con_reintentos(f"{GRAPH_URL}/{pagina['id']}",
                                        {"access_token": token, "fields": "instagram_business_account"})
            ig = (info.get("instagram_business_account") or {}).get("id")
        if not ig:
            continue
        print(f"Cuenta IG {ig} (pagina '{pagina.get('name','')}'). Busco el reel {shortcode}...")
        url = f"{GRAPH_URL}/{ig}/media"
        params = {"access_token": token, "fields": "id,permalink", "limit": 100}
        for hoja in range(60):
            data = pedir_con_reintentos(url, params)
            for m in data.get("data", []):
                if shortcode in (m.get("permalink") or ""):
                    print(f"Reel encontrado. Media ID: {m['id']}")
                    return m["id"]
            nxt = (data.get("paging") or {}).get("next")
            if not nxt:
                break
            url, params = nxt, {}
            print(f"  ...pagina {hoja + 2} de posteos", end="\r")
    raise RuntimeError(f"No encontre el reel {shortcode} en la cuenta. Pasa --media con el Media ID directo.")


def main():
    ap = argparse.ArgumentParser(description="Baja los comentarios de un posteo de Instagram a comentarios.csv")
    ap.add_argument("--token", default=ACCESS_TOKEN, help="Token del Graph API Explorer (dura 1-2 h)")
    ap.add_argument("--media", default="", help="Media ID del posteo")
    ap.add_argument("--reel", default="", help="Link del reel (resuelve el Media ID solo)")
    ap.add_argument("--reset", action="store_true", help="Borra el progreso y baja todo de cero")
    ap.add_argument("--version", default=VERSION, help=f"Version de la Graph API (default {VERSION})")
    a = ap.parse_args()

    global GRAPH_URL
    if a.version != VERSION:
        GRAPH_URL = "https://graph.facebook.com/" + a.version
        print(f"Uso la Graph API {a.version}")

    token = (a.token or "").strip()
    if not token or token == "PEGAR_ACA_EL_TOKEN":
        sys.exit("ERROR: falta el token. Usa --token EAAG...")

    if a.reset:
        for p in (CSV_PATH, ESTADO_PATH):
            if os.path.exists(p):
                os.remove(p)
        print("Progreso borrado: bajo todo de cero.")

    media = (a.media or "").strip() or (MEDIA_ID if MEDIA_ID != "PEGAR_ACA_EL_MEDIA_ID" else "")
    if not media:
        sc = shortcode_de_reel(a.reel)
        if not sc:
            sys.exit("ERROR: pasa --media <id> o --reel <link del reel>.")
        media = resolver_media_id(token, sc)

    comentarios = obtener_comentarios(media, token)
    if not comentarios:
        print("No se encontraron comentarios.")
        return
    respuestas = sum(1 for c in comentarios if c.get("respuesta_a"))
    sin_likes = sum(1 for c in comentarios if int(c.get("like_count") or 0) == 0)
    print(f"Listo: {len(comentarios)} comentarios en {CSV_PATH} (media {media}).")
    print(f"  de primer nivel: {len(comentarios) - respuestas}  |  respuestas dentro de un hilo: {respuestas}")
    print(f"Comentarios con 0 likes: {sin_likes}")
    print('Sigue:  node preparar.js --csv comentarios.csv --menos-likes --excluir damiancivale --fecha "AAAA-MM-DDTHH:MM:00-03:00"')


if __name__ == "__main__":
    main()
