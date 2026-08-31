"""
Convierte comentarios.csv en datos.json, que es lo que consume la pagina.

    python armar-datos.py                 (mantiene 'publicado' y 'declarados' de la corrida anterior)
    python armar-datos.py --token EAAG... (los vuelve a leer de la API)

datos.json SI lleva el texto de los comentarios: es para trabajar en local y esta en
.gitignore. Lo que se publica lo arma armar-publicacion.js, que saca los textos.
"""

import argparse
import csv
import json
import os
from datetime import datetime, timezone

REEL = "https://www.instagram.com/reel/Dbe0kXLgFfk/"
MEDIA_ID = "18089981288450471"
CSV_PATH = "comentarios.csv"
SALIDA = "datos.json"


def main():
    ap = argparse.ArgumentParser(description="comentarios.csv -> datos.json")
    ap.add_argument("--token", default="", help="Si se pasa, relee publicado y declarados de la API")
    ap.add_argument("--csv", default=CSV_PATH)
    ap.add_argument("--media", default=MEDIA_ID)
    a = ap.parse_args()

    previo = {}
    if os.path.exists(SALIDA):
        with open(SALIDA, encoding="utf-8") as f:
            previo = json.load(f)

    publicado = previo.get("publicado")
    declarados = previo.get("declarados")

    if a.token.strip():
        from sorteo_ig import GRAPH_URL, pedir_con_reintentos
        info = pedir_con_reintentos(f"{GRAPH_URL}/{a.media}",
                                    {"access_token": a.token.strip(),
                                     "fields": "timestamp,comments_count,permalink"})
        publicado = info.get("timestamp") or publicado
        declarados = info.get("comments_count", declarados)
        print(f"De la API: publicado {publicado} | Instagram declara {declarados}")

    comentarios = []
    with open(a.csv, newline="", encoding="utf-8") as f:
        for fila in csv.DictReader(f):
            comentarios.append({
                "u": fila["username"],
                "l": int(fila.get("like_count") or 0),
                "t": fila.get("text") or "",
                "ts": fila["timestamp"],
                "id": fila["id"],
                # r: 1 si es una respuesta dentro de un hilo, 0 si es de primer nivel.
                # La pagina solo necesita distinguirlas, no saber de quien cuelgan.
                "r": 1 if fila.get("respuesta_a") else 0,
            })

    # Mas viejo primero no: se deja el orden del CSV, que es el que devolvio Meta. El sorteo
    # ordena por su cuenta y el orden de entrada no puede influir en el resultado.
    datos = {
        "reel": previo.get("reel") or REEL,
        "mediaId": a.media,
        "publicado": publicado,
        "bajado": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "declarados": declarados,
        "comentarios": comentarios,
    }

    with open(SALIDA, "w", encoding="utf-8") as f:
        json.dump(datos, f, ensure_ascii=False)

    respuestas = sum(1 for c in comentarios if c["r"])
    print(f"{SALIDA}: {len(comentarios)} comentarios "
          f"({len(comentarios) - respuestas} de primer nivel + {respuestas} respuestas), "
          f"{len({c['u'] for c in comentarios})} personas.")
    if declarados:
        print(f"Instagram declara {declarados}.")


if __name__ == "__main__":
    main()
