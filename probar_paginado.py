"""
Sonda: barre el edge /comments con distintos tamanos de pagina y cuenta cuantos
comentarios de primer nivel UNICOS trae cada uno. No escribe comentarios.csv.

Para que sirve
--------------
Con limit=50 la paginacion se atasca en ~475 sin dar error. Con limit=500 trae
2.951. La pregunta es si 2.951 es el techo real de la API o es otra vez la
paginacion cortando antes de tiempo, mas arriba.

Si los tres tamanos dan el MISMO total, ese es el techo de la API y lo que falta
no lo vamos a poder bajar. Si dan totales distintos, la paginacion sigue
recortando y hay que seguir subiendo.

Ademas mide la UNION: comentarios que aparecieron en una pasada y no en otra.
Si la union es mayor que la pasada mas grande, el listado de Meta no es estable
y conviene barrer varias veces y acumular.

Uso:
    python probar_paginado.py --token EAAG...
    python probar_paginado.py --token EAAG... --limites 100,250,500,1000
"""

import argparse
import json
import sys

from sorteo_ig import GRAPH_URL, cargar_progreso, cursor_de_next, pedir_con_reintentos

MEDIA_ID = "18089981288450471"  # reel del Alpine (Dbe0kXLgFfk)
MAX_PAGINAS = 400


def barrer(media, token, limite):
    """Devuelve (ids de primer nivel, paginas recorridas, motivo de corte)."""
    url = f"{GRAPH_URL}/{media}/comments"
    params = {"fields": "id,timestamp", "access_token": token, "limit": limite}
    ids, cursores = set(), set()

    for pagina in range(1, MAX_PAGINAS + 1):
        data = pedir_con_reintentos(url, params)
        for c in data.get("data", []):
            ids.add(c["id"])
        print(f"    limit={limite}: pagina {pagina}, {len(ids)} unicos", end="\r")

        siguiente = (data.get("paging") or {}).get("next")
        if not siguiente:
            return ids, pagina, "Meta dejo de dar paginas (fin del listado)"

        cursor = cursor_de_next(siguiente)
        if cursor and cursor in cursores:
            return ids, pagina, "ATASCO: Meta repitio el mismo cursor"
        if cursor:
            cursores.add(cursor)
        url, params = siguiente, {}

    return ids, MAX_PAGINAS, f"corte por tope de {MAX_PAGINAS} paginas"


def main():
    ap = argparse.ArgumentParser(description="Compara el barrido de /comments con distintos limit")
    ap.add_argument("--token", default="", help="Token del Graph API Explorer")
    ap.add_argument("--media", default=MEDIA_ID)
    ap.add_argument("--limites", default="100,250,500", help="Tamanos de pagina separados por coma")
    a = ap.parse_args()

    token = (a.token or "").strip()
    if not token:
        sys.exit("ERROR: falta el token. Usa --token EAAG...")

    info = pedir_con_reintentos(f"{GRAPH_URL}/{a.media}",
                                {"access_token": token, "fields": "comments_count"})
    oficial = info.get("comments_count")
    print(f"Instagram declara {oficial} comentarios (incluye las respuestas).\n")

    guardados, _ = cargar_progreso()
    padres_guardados = {c["id"] for c in guardados if not c.get("respuesta_a")}
    print(f"En comentarios.csv tengo {len(padres_guardados)} de primer nivel.\n")

    resultados = {}
    for limite in [int(x) for x in a.limites.split(",") if x.strip()]:
        print(f"  Barriendo con limit={limite}...")
        try:
            ids, paginas, motivo = barrer(a.media, token, limite)
        except RuntimeError as e:
            print(f"    limit={limite}: FALLO -> {e}")
            continue
        resultados[limite] = ids
        print(f"    limit={limite}: {len(ids)} unicos en {paginas} paginas | {motivo}"
              + " " * 20)

    if not resultados:
        sys.exit("\nNinguna pasada termino.")

    union = set().union(*resultados.values())
    print("\n--- Resumen ---")
    for limite, ids in sorted(resultados.items()):
        solo = len(ids - (union - ids)) if len(resultados) > 1 else len(ids)
        print(f"  limit={limite:<5} {len(ids):>5} unicos")
    print(f"  UNION de todas  {len(union):>5}")
    print(f"  guardados antes {len(padres_guardados):>5}")
    nuevos = union - padres_guardados
    print(f"  NUEVOS que no estaban en el CSV: {len(nuevos)}")

    iguales = len({len(v) for v in resultados.values()}) == 1
    if iguales and len(union) == max(len(v) for v in resultados.values()):
        print("\nVEREDICTO: todos los tamanos dan lo mismo y la union no agrega nada.")
        print("Ese es el techo de la API: lo que falta contra el contador de Instagram")
        print("no se puede bajar (comentarios ocultos por el filtro o borrados por su autor).")
    else:
        print("\nVEREDICTO: los barridos NO coinciden. El listado de Meta no es estable o la")
        print("paginacion sigue recortando: conviene barrer varias veces y acumular por id.")

    with open("sonda_paginado.json", "w", encoding="utf-8") as f:
        json.dump({"oficial": oficial,
                   "por_limite": {str(k): len(v) for k, v in resultados.items()},
                   "union": len(union),
                   "nuevos_vs_csv": sorted(nuevos)}, f, indent=1)
    print("\nDetalle en sonda_paginado.json")


if __name__ == "__main__":
    main()
