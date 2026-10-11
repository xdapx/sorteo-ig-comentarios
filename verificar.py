#!/usr/bin/env python3
"""
Reproduce el sorteo en Python, sin depender del código JavaScript. Solo librería estándar.
Corta con error si algo no cierra (lista inválida, huella distinta, ronda que no corresponde a la fecha).
Uso:
    python verificar.py                  -> consulta la ronda de drand indicada en sorteo.json
    python verificar.py --semilla <hex>  -> usa esa semilla
    python verificar.py --codigo <hex>   -> compara con el código del sorteo publicado
"""
import hashlib, json, os, re, sys, urllib.request
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
QUICKNET = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
GENESIS, PERIODO = 1692803367, 3
ESPEJOS = ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"]
RE_FECHA = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$")
# Boleto: un usuario, o "usuario#n" (su n-ésimo comentario) cuando cada comentario es una chance.
RE_USUARIO = re.compile(r"^[a-z0-9._]{1,30}(#[1-9][0-9]{0,4})?$")
RE_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def sha256(texto):
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def ronda_para_fecha(fecha):
    if not RE_FECHA.match(fecha):
        sys.exit(f"ERROR: fechaSorteo necesita formato ISO con zona horaria (recibí: {fecha})")
    t = int(datetime.fromisoformat(fecha.replace("Z", "+00:00")).timestamp())
    return (t - GENESIS) // PERIODO + 1


def main():
    cfg = json.load(open(os.path.join(BASE, "sorteo.json"), encoding="utf-8"))
    padron = json.load(open(os.path.join(BASE, cfg.get("participantes", "participantes.json")), encoding="utf-8"))
    usuarios = padron["usuarios"]
    if cfg.get("prueba"):
        print("*** sorteo.json está marcado como PRUEBA LOCAL ***")

    vistos = set()
    for i, u in enumerate(usuarios):
        if not isinstance(u, str) or not RE_USUARIO.match(u):
            sys.exit(f"ERROR: usuario inválido en la posición {i + 1}: {u!r}")
        if u in vistos:
            sys.exit(f"ERROR: usuario repetido: {u}")
        vistos.add(u)
    hash_lista = sha256("".join(u + "\n" for u in usuarios))
    print(f"Boletos:           {len(usuarios)}  ({len({u.split('#')[0] for u in usuarios})} personas)")
    print(f"Huella calculada:  {hash_lista}")
    if hash_lista != str(padron.get("sha256", "")).lower():
        sys.exit(f"ERROR: la huella no coincide con participantes.json ({padron.get('sha256')})")
    if hash_lista != str(cfg.get("participantesSha256", "")).lower():
        sys.exit(f"ERROR: la huella no coincide con sorteo.json ({cfg.get('participantesSha256')})")
    print("  == participantes.json y sorteo.json: SI")

    ronda = ronda_para_fecha(cfg["fechaSorteo"])
    if int(cfg["ronda"]) != ronda:
        sys.exit(f"ERROR: sorteo.json dice ronda #{cfg['ronda']} pero la fecha anunciada corresponde a la #{ronda}")
    # Modo vivo: la ronda la fija el toque; sorteo.json trae la mínima. Se pasa con --ronda.
    if cfg.get("modo") == "vivo":
        if "--ronda" not in sys.argv:
            sys.exit("ERROR: sorteo en vivo: pasá --ronda <número> (está en el link de verificación publicado).")
        r = int(sys.argv[sys.argv.index("--ronda") + 1])
        if r < ronda:
            sys.exit(f"ERROR: la ronda #{r} es anterior a la mínima #{ronda}: salió antes de cerrar la lista.")
        ronda = r
    fecha_ronda = datetime.fromtimestamp(GENESIS + (ronda - 1) * PERIODO, tz=timezone.utc)
    print(f"Ronda drand:       #{ronda}  = {fecha_ronda.isoformat()}")

    if "--semilla" in sys.argv:
        semilla = sys.argv[sys.argv.index("--semilla") + 1].lower()
        if not RE_HEX64.match(semilla):
            sys.exit("ERROR: Semilla inválida: se esperan 64 caracteres hexadecimales.")
        print(f"Semilla (manual):  {semilla}")
    else:
        vistos, firma = {}, None
        for e in ESPEJOS:
            try:
                req = urllib.request.Request(f"{e}/{QUICKNET}/public/{ronda}", headers={"User-Agent": "sorteo-verificar/1.0"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    j = json.load(r)
                if int(j["round"]) != int(ronda):
                    print(f"  {e}: devolvió otra ronda ({j['round']})")
                    continue
                rnd = str(j["randomness"]).lower()
                if not RE_HEX64.match(rnd):
                    print(f"  {e}: randomness inválida")
                    continue
                vistos[e] = rnd
                firma = firma or j.get("signature")
            except Exception as ex:
                print(f"  {e}: sin respuesta ({ex})")
        if not vistos:
            sys.exit("ERROR: Ninguna fuente de drand devolvió la ronda.")
        if len(set(vistos.values())) != 1:
            sys.exit("ERROR: Las fuentes de drand no coinciden: " + json.dumps(vistos))
        semilla = next(iter(vistos.values()))
        print(f"Semilla:           {semilla}  (fuentes que coinciden: {len(vistos)}/{len(ESPEJOS)})")
        if len(vistos) < 2:
            print("AVISO: respondió una sola fuente; cotejá la semilla en otro espejo de drand.")
        try:
            coincide = hashlib.sha256(bytes.fromhex(firma)).hexdigest() == semilla
            print(f"Consistencia randomness == SHA-256(firma): {'SI' if coincide else 'NO'}  (no verifica la firma BLS)")
        except (TypeError, ValueError):
            print("Consistencia randomness == SHA-256(firma): no verificable")

    boletos = sorted((sha256(semilla + ":" + u), u) for u in usuarios)
    # Cada persona una sola vez, en su mejor boleto: nadie gana dos veces.
    orden, ya = [], set()
    for _, b in boletos:
        u = b.split("#")[0]
        if u not in ya:
            ya.add(u)
            orden.append(u)
    n, m = int(cfg["ganadores"]), int(cfg["suplentes"])
    ganadores = orden[:n]
    suplentes = orden[n:n + m]
    print(f"\nGANADORES ({n}):")
    for i, u in enumerate(ganadores, 1):
        print(f"  {i}. @{u}")
    print(f"SUPLENTES ({m}):")
    for i, u in enumerate(suplentes, 1):
        print(f"  {i}. @{u}")
    codigo = sha256("|".join([hash_lista, cfg.get("cadena", "quicknet"), str(ronda), semilla, ",".join(ganadores), ",".join(suplentes)]))
    print(f"\nCODIGO DEL SORTEO: {codigo}")
    if "--codigo" in sys.argv:
        pub = sys.argv[sys.argv.index("--codigo") + 1].lower()
        print(f"  == codigo publicado: {'SI' if pub == codigo else 'NO'}")
        if pub != codigo:
            sys.exit(1)


if __name__ == "__main__":
    main()
