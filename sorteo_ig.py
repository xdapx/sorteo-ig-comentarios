"""
Trae todos los comentarios de un posteo de Instagram (cuenta Business/Creator)
con su cantidad de likes, y elige UN ganador entre los que tienen MENOS likes.

Como en un sorteo la mayoria de los comentarios tienen 0 likes, "el de menos
likes" casi siempre es un empate de decenas de miles. Por eso, entre todos los
empatados en el minimo, se elige uno AL AZAR con una semilla registrada: quien
tenga el CSV y esa semilla puede reproducir exactamente el mismo ganador
(sorteo auditable).

Pensado para volumenes grandes (cientos de miles de comentarios):
  - Guarda progreso en comentarios.csv a medida que avanza.
  - Guarda el CURSOR de paginacion en estado_sorteo.json, asi si se corta
    retoma desde donde iba (NO vuelve a descargar todo desde el principio,
    que quemaria la cuota de la API).
  - Distingue rate limit (espera y reintenta) de errores permanentes como
    token vencido o media invalido (frena y muestra el error real de Meta).

Uso:
    pip install requests
    python sorteo_ig.py

Antes de correr, completar ACCESS_TOKEN y MEDIA_ID abajo.
"""

import csv
import json
import os
import random
import time
from urllib.parse import parse_qs, urlparse

import requests

ACCESS_TOKEN = "PEGAR_ACA_EL_TOKEN"
MEDIA_ID = "PEGAR_ACA_EL_MEDIA_ID"

# Semilla del sorteo. Dejar en None para que el script genere una al azar y la
# registre (en ganador.txt y en pantalla). Para REPRODUCIR un ganador ya
# sorteado, pegar aca el numero de semilla que quedo guardado y volver a correr.
SEMILLA = None

GRAPH_URL = "https://graph.facebook.com/v21.0"
CSV_PATH = "comentarios.csv"
ESTADO_PATH = "estado_sorteo.json"
GANADOR_PATH = "ganador.txt"
CAMPOS = ["id", "username", "text", "like_count", "timestamp"]

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


def guardar_lote(lote, primer_escritura):
    modo = "w" if primer_escritura else "a"
    with open(CSV_PATH, modo, newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CAMPOS)
        if primer_escritura:
            writer.writeheader()
        for c in lote:
            writer.writerow({k: c.get(k, "") for k in CAMPOS})


# --------------------------- pedidos a la API ---------------------------

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

    if estado.get("completado"):
        print(f"La descarga ya se completo en una corrida anterior: uso {CSV_PATH} "
              f"({len(comentarios_previos)} comentarios). Borra {CSV_PATH} y {ESTADO_PATH} "
              "si queres re-descargar.")
        return comentarios_previos

    todos = list(comentarios_previos)
    primer_escritura = not comentarios_previos
    if comentarios_previos:
        print(f"Retomo progreso: {len(comentarios_previos)} comentarios ya guardados"
              + (" (desde el cursor guardado)." if estado.get("after") else "."))

    url = f"{GRAPH_URL}/{media_id}/comments"
    params = {
        "fields": "id,text,username,like_count,timestamp",
        "access_token": token,
        "limit": 100,
    }
    if estado.get("after"):
        params["after"] = estado["after"]

    while True:
        data = pedir_con_reintentos(url, params)

        lote = data.get("data", [])
        lote_nuevo = [c for c in lote if c["id"] not in ids_vistos]
        for c in lote_nuevo:
            ids_vistos.add(c["id"])

        if lote_nuevo:
            guardar_lote(lote_nuevo, primer_escritura)
            primer_escritura = False
            todos.extend(lote_nuevo)

        print(f"  Progreso: {len(todos)} comentarios bajados...", end="\r")

        paging = data.get("paging", {})
        after = paging.get("cursors", {}).get("after") or cursor_de_next(paging.get("next"))

        if not paging.get("next") or not after:
            guardar_estado({"completado": True})
            break

        guardar_estado({"after": after, "completado": False})
        params["after"] = after

    print()
    return todos


# --------------------------- eleccion del ganador ---------------------------

def elegir_ganador(comentarios):
    comentarios.sort(key=lambda c: int(c.get("like_count") or 0))
    min_likes = int(comentarios[0].get("like_count") or 0)

    empatados = [c for c in comentarios if int(c.get("like_count") or 0) == min_likes]
    # Orden estable (por id) para que, con la misma semilla, salga el mismo ganador.
    empatados.sort(key=lambda c: c["id"])

    semilla = SEMILLA if SEMILLA is not None else int.from_bytes(os.urandom(8), "big")
    ganador = random.Random(semilla).choice(empatados)

    print(f"\nTotal de comentarios: {len(comentarios)}  (guardados en {CSV_PATH})")
    print(f"Menor cantidad de likes: {min_likes}  ->  {len(empatados)} comentarios empatados")
    print(f"Semilla del sorteo: {semilla}")
    print("\n=========================  GANADOR  =========================")
    print(f"  @{ganador['username']}")
    print(f"  \"{ganador.get('text', '')}\"")
    print(f"  likes: {int(ganador.get('like_count') or 0)} | id: {ganador['id']} "
          f"| fecha: {ganador.get('timestamp', '')}")
    print("=============================================================")
    print(f"\nAuditable: con {CSV_PATH} y SEMILLA = {semilla} se reproduce este mismo ganador.")

    with open(GANADOR_PATH, "w", encoding="utf-8") as f:
        f.write("GANADOR DEL SORTEO\n")
        f.write(f"usuario:  @{ganador['username']}\n")
        f.write(f"comentario: {ganador.get('text', '')}\n")
        f.write(f"likes: {int(ganador.get('like_count') or 0)}\n")
        f.write(f"id: {ganador['id']}\n")
        f.write(f"fecha: {ganador.get('timestamp', '')}\n\n")
        f.write(f"menor_cantidad_de_likes: {min_likes}\n")
        f.write(f"comentarios_empatados_en_ese_minimo: {len(empatados)}\n")
        f.write(f"semilla: {semilla}\n")
        f.write("Reproducible: mismo comentarios.csv + misma semilla => mismo ganador.\n")
    print(f"(guardado tambien en {GANADOR_PATH})")


def main():
    comentarios = obtener_comentarios(MEDIA_ID, ACCESS_TOKEN)
    if not comentarios:
        print("No se encontraron comentarios.")
        return
    elegir_ganador(comentarios)


if __name__ == "__main__":
    main()
