"""
Segunda pasada: baja las RESPUESTAS de cada comentario, una por una.

Por que hace falta una pasada aparte
------------------------------------
El edge /comments solo devuelve comentarios de primer nivel. Las respuestas se
piden por expansion (replies.limit(200){...}) en el mismo pedido, y ahi esta la
trampa: cuando la pagina es grande (limit=500), la respuesta de Meta se pasa del
tamano maximo y Meta RECORTA las sub-edges EN SILENCIO. No da error, no avisa:
simplemente algunos hilos vuelven sin sus respuestas.

Resultado medido el 31/08/2026 en el reel del Alpine: la expansion trajo 556
respuestas cuando el contador de Instagram implicaba mas del triple.

La unica forma confiable es pedirle a la API /{comment-id}/replies a cada
comentario por separado. Son miles de pedidos, asi que se usa la BATCH API de
Meta: 50 pedidos por request HTTP.

Uso:
    python bajar_respuestas.py --token EAAG...
    python bajar_respuestas.py --token EAAG... --media 18089981288450471

Es acumulativo e idempotente: se puede cortar y volver a correr, retoma donde
iba (estado_respuestas.json) y nunca borra lo que ya estaba en comentarios.csv.
"""

import argparse
import json
import os
import sys
import time

import requests

from sorteo_ig import (
    CSV_PATH,
    GRAPH_URL,
    MAX_REINTENTOS,
    cargar_progreso,
    pedir_con_reintentos,
    reescribir_todo,
)

ESTADO_PATH = "estado_respuestas.json"
MEDIA_ID = "18089981288450471"  # reel del Alpine (Dbe0kXLgFfk)
CAMPOS_RESPUESTA = "id,text,username,like_count,timestamp"
POR_LOTE = 50  # maximo que acepta la batch API de Meta


def cargar_estado():
    if not os.path.exists(ESTADO_PATH):
        return {"consultados": []}
    try:
        with open(ESTADO_PATH, encoding="utf-8") as f:
            d = json.load(f)
            d.setdefault("consultados", [])
            return d
    except (json.JSONDecodeError, OSError):
        return {"consultados": []}


def guardar_estado(estado):
    with open(ESTADO_PATH, "w", encoding="utf-8") as f:
        json.dump(estado, f)


def pedir_lote(token, ids):
    """Un request HTTP con hasta 50 GET adentro. Devuelve {comment_id: [respuestas]}."""
    batch = [
        {"method": "GET",
         "relative_url": f"{cid}/replies?fields={CAMPOS_RESPUESTA}&limit=200"}
        for cid in ids
    ]
    espera = 30
    for intento in range(1, MAX_REINTENTOS + 1):
        resp = requests.post(GRAPH_URL, timeout=120, data={
            "access_token": token,
            "batch": json.dumps(batch),
            "include_headers": "false",
        })

        if resp.status_code == 200:
            partes = resp.json()
            if not isinstance(partes, list):
                err = (partes or {}).get("error", {})
                if err.get("code") == 190:
                    raise RuntimeError(f"Token invalido o vencido (190): {err.get('message')}")
                raise RuntimeError(f"Respuesta inesperada de la batch API: {str(partes)[:300]}")
            salida = {}
            for cid, parte in zip(ids, partes):
                # Meta manda null cuando ese sub-pedido no llego a ejecutarse (timeout del lote).
                if not parte or parte.get("code") != 200:
                    continue
                try:
                    cuerpo = json.loads(parte.get("body") or "{}")
                except ValueError:
                    continue
                salida[cid] = cuerpo.get("data", [])
                # Un hilo con mas de 200 respuestas sigue paginando aparte. Es rarisimo,
                # pero si pasa hay que seguirlo o se pierden en silencio igual que antes.
                siguiente = (cuerpo.get("paging") or {}).get("next")
                while siguiente:
                    extra = pedir_con_reintentos(siguiente, {})
                    salida[cid].extend(extra.get("data", []))
                    siguiente = (extra.get("paging") or {}).get("next")
            return salida

        try:
            err = resp.json().get("error", {})
        except ValueError:
            err = {}
        code = err.get("code")
        if code == 190:
            raise RuntimeError(
                f"Token invalido o vencido (codigo 190). Meta dice: {err.get('message')}\n"
                "Genera un token nuevo y volve a correr: retoma desde donde iba."
            )
        if resp.status_code == 429 or code in (4, 17, 32, 613, 80004) or resp.status_code in (500, 502, 503):
            print(f"  Rate limit / error {resp.status_code} (codigo {code}). Espero {espera}s "
                  f"y reintento ({intento}/{MAX_REINTENTOS})...        ")
            time.sleep(espera)
            espera = min(1200, espera * 2)
            continue
        raise RuntimeError(f"Error {resp.status_code} de Meta (codigo {code}): "
                           f"{err.get('message') or resp.text[:300]}")

    raise RuntimeError(f"No se pudo completar el lote tras {MAX_REINTENTOS} reintentos. "
                       "El progreso quedo guardado: volve a correr mas tarde.")


def main():
    ap = argparse.ArgumentParser(description="Baja las respuestas de cada comentario, una por una")
    ap.add_argument("--token", default="", help="Token del Graph API Explorer (dura 1-2 h)")
    ap.add_argument("--media", default=MEDIA_ID, help="Media ID del posteo (para comparar el total)")
    ap.add_argument("--reset", action="store_true", help="Vuelve a consultar TODOS los comentarios")
    a = ap.parse_args()

    token = (a.token or "").strip()
    if not token:
        sys.exit("ERROR: falta el token. Usa --token EAAG...")

    comentarios, ids_vistos = cargar_progreso()
    if not comentarios:
        sys.exit(f"ERROR: no hay {CSV_PATH}. Corre primero sorteo_ig.py.")

    if a.reset and os.path.exists(ESTADO_PATH):
        os.remove(ESTADO_PATH)
    estado = cargar_estado()
    ya = set(estado["consultados"])

    # Se le pregunta a TODO comentario, no solo a los que ya sabemos que tienen respuestas:
    # justamente el problema es que no sabemos cuales las tienen (no hay campo reply_count).
    # Las respuestas de una respuesta no existen en Instagram: los hilos son de un solo nivel.
    padres = [c["id"] for c in comentarios if not c.get("respuesta_a")]
    pendientes = [cid for cid in padres if cid not in ya]

    # Cuanto dice Instagram que hay. Su contador incluye las respuestas.
    try:
        info = pedir_con_reintentos(f"{GRAPH_URL}/{a.media}",
                                    {"access_token": token, "fields": "comments_count,permalink"})
        oficial = info.get("comments_count")
        print(f"Instagram declara {oficial} comentarios en el posteo.")
    except RuntimeError as e:
        oficial = None
        print(f"(No pude leer el contador oficial: {e})")

    print(f"Tengo {len(comentarios)} filas: {len(padres)} de primer nivel y "
          f"{len(comentarios) - len(padres)} respuestas.")
    print(f"Consulto las respuestas de {len(pendientes)} comentarios "
          f"({len(ya)} ya consultados) en lotes de {POR_LOTE}.\n")

    nuevas = 0
    por_id = {c["id"]: c for c in comentarios}
    refrescadas = set()  # respuestas a las que les cambiaron los likes
    for i in range(0, len(pendientes), POR_LOTE):
        lote_ids = pendientes[i:i + POR_LOTE]
        resultados = pedir_lote(token, lote_ids)

        filas = []
        for cid, respuestas in resultados.items():
            for r in respuestas:
                r["respuesta_a"] = cid
                previo = por_id.get(r["id"])
                if previo is None:
                    ids_vistos.add(r["id"])
                    por_id[r["id"]] = r
                    filas.append(r)
                    continue
                # Ya estaba: se le pisan los likes con el valor de ahora, igual que en el
                # barrido principal. Un numero de likes viejo elige mal al ganador.
                for k in ("username", "text", "like_count", "timestamp", "respuesta_a"):
                    if k in r and r[k] != previo.get(k):
                        if k == "like_count":
                            refrescadas.add(r["id"])
                        previo[k] = r[k]

        if filas or refrescadas:
            comentarios.extend(filas)
            nuevas += len(filas)
            reescribir_todo(comentarios)  # se guarda en cada lote: si se corta, no se pierde nada

        ya.update(resultados.keys())
        estado["consultados"] = sorted(ya)
        guardar_estado(estado)

        hechos = min(i + POR_LOTE, len(pendientes))
        print(f"  {hechos}/{len(pendientes)} consultados | +{nuevas} respuestas nuevas | "
              f"{len(refrescadas)} con los likes cambiados    ", end="\r")

    print()
    respuestas = sum(1 for c in comentarios if c.get("respuesta_a"))
    print(f"\nListo. {len(comentarios)} filas en {CSV_PATH}: "
          f"{len(comentarios) - respuestas} de primer nivel + {respuestas} respuestas.")
    print(f"Respuestas nuevas encontradas en esta pasada: {nuevas}")
    print(f"Respuestas a las que les cambiaron los likes: {len(refrescadas)}")
    if oficial:
        falta = oficial - len(comentarios)
        print(f"Instagram declara {oficial}: {'faltan ' + str(falta) if falta > 0 else 'cubierto'}"
              f" ({100 * len(comentarios) // oficial}% de cobertura)")


if __name__ == "__main__":
    main()
