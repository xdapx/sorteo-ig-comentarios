/*
  Sorteo transparente — núcleo del algoritmo.
  El MISMO archivo corre en el navegador (sortear.html / verificar.html) y en Node (verificar.js),
  así cualquiera puede reproducir el resultado con exactamente el mismo código.

  Definiciones exactas (para reproducir sin leer el código):
    usuario   = el string tal cual figura en participantes.json (minúsculas, sin @, solo [a-z0-9._], 1 a 30).
    huella    = SHA-256 (hex) de los bytes UTF-8 de: cada usuario seguido de "\n", concatenados en el orden del archivo.
    ronda     = floor((t - 1692803367) / 3) + 1, con t = fecha del sorteo en epoch (segundos). Cadena drand "quicknet".
    semilla   = campo "randomness" de esa ronda (64 hex en minúscula), usado como TEXTO.
    puntaje   = SHA-256 (hex) de los bytes UTF-8 de: semilla + ":" + usuario.
    orden     = puntaje ascendente (comparación de strings hex); desempate por usuario ascendente.
    ganadores = primeros N; suplentes = siguientes M.
    código    = SHA-256 (hex) de: huella + "|" + cadena + "|" + ronda + "|" + semilla + "|" + ganadores unidos por "," + "|" + suplentes unidos por ",".
*/
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SorteoCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CADENAS = {
    quicknet: {
      id: "quicknet",
      hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
      genesis: 1692803367, // epoch (segundos) de la ronda 1
      periodo: 3           // segundos entre rondas
    }
  };
  const ESPEJOS = [
    "https://api.drand.sh",
    "https://api2.drand.sh",
    "https://api3.drand.sh",
    "https://drand.cloudflare.com"
  ];
  // Único formato de fecha aceptado: ISO con zona horaria explícita (lo parsean igual todos los navegadores).
  const REGEX_FECHA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

  const enc = new TextEncoder();
  function subtle() {
    const c = globalThis.crypto;
    if (!c || !c.subtle) throw new Error("Este navegador no tiene Web Crypto (hace falta HTTPS).");
    return c.subtle;
  }
  function aHex(buf) { return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join(""); }
  function deHex(h) { const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16); return out; }
  async function sha256(texto) { return aHex(await subtle().digest("SHA-256", enc.encode(texto))); }
  async function sha256Bytes(bytes) { return aHex(await subtle().digest("SHA-256", bytes)); }

  function normalizarUsuario(u) { return String(u == null ? "" : u).trim().replace(/^@+/, "").toLowerCase(); }
  const esHex64 = s => /^[0-9a-f]{64}$/.test(String(s || ""));
  // Instagram solo permite letras minúsculas, números, punto y guion bajo (1 a 30). Cualquier otra cosa es fabricada.
  const esUsuarioIG = u => /^[a-z0-9._]{1,30}$/.test(String(u));
  function validarLista(usuarios) {
    if (!Array.isArray(usuarios) || !usuarios.length) throw new Error("La lista está vacía.");
    const vistos = new Set();
    usuarios.forEach((u, i) => {
      if (typeof u !== "string" || u !== normalizarUsuario(u) || !esUsuarioIG(u)) throw new Error("usuario inválido en la posición " + (i + 1) + ": " + JSON.stringify(u));
      if (vistos.has(u)) throw new Error("usuario repetido: " + u);
      vistos.add(u);
    });
    return true;
  }

  // Huella de la lista: SHA-256 del texto formado por "usuario\n" por cada usuario, en el orden publicado.
  // Equivale a:   jq -r '.usuarios[]' participantes.json | sha256sum
  async function hashLista(usuarios) { return sha256(usuarios.map(u => u + "\n").join("")); }
  // Huella de la evidencia: "usuario\tid\ttimestamp\n" por cada usuario, en el orden de la lista.
  async function hashEvidencia(usuarios, comentarios) {
    return sha256(usuarios.map(u => { const c = (comentarios || {})[u] || {}; return u + "\t" + (c.id || "") + "\t" + (c.ts || "") + "\n"; }).join(""));
  }

  function rondaParaFecha(fecha, cadena) {
    cadena = cadena || CADENAS.quicknet;
    let t;
    if (typeof fecha === "number") t = Math.floor(fecha);
    else {
      if (!REGEX_FECHA.test(String(fecha))) throw new Error("La fecha necesita formato ISO con zona horaria, ej. 2026-09-05T20:00:00-03:00 (recibí: " + fecha + ")");
      t = Math.floor(new Date(fecha).getTime() / 1000);
    }
    if (!isFinite(t)) throw new Error("Fecha inválida: " + fecha);
    return Math.floor((t - cadena.genesis) / cadena.periodo) + 1;
  }
  function esMinutoEnPunto(fecha) {
    if (!REGEX_FECHA.test(String(fecha))) return false;
    const d = new Date(fecha);
    return isFinite(d) && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  }
  function fechaDeRonda(ronda, cadena) {
    cadena = cadena || CADENAS.quicknet;
    return new Date((cadena.genesis + (Number(ronda) - 1) * cadena.periodo) * 1000);
  }
  function urlRonda(ronda, cadena, espejo) {
    cadena = cadena || CADENAS.quicknet;
    return (espejo || ESPEJOS[0]) + "/" + cadena.hash + "/public/" + ronda;
  }
  function shortcodeDeReel(url) { const m = String(url || "").match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i); return m ? m[1] : ""; }
  function urlComentario(reel, idComentario) { const sc = shortcodeDeReel(reel); return sc && idComentario ? "https://www.instagram.com/p/" + sc + "/c/" + idComentario + "/" : ""; }

  async function puntaje(semilla, usuario) { return sha256(semilla + ":" + usuario); }

  async function sortear(usuarios, semilla, nGanadores, nSuplentes, onProgreso) {
    semilla = String(semilla || "").toLowerCase();
    if (!esHex64(semilla)) throw new Error("Semilla inválida: se esperan 64 caracteres hexadecimales.");
    const lista = usuarios.map(normalizarUsuario);
    validarLista(lista);
    const puntajes = [];
    const LOTE = 1000;
    for (let i = 0; i < lista.length; i += LOTE) {
      const parte = lista.slice(i, i + LOTE);
      const hs = await Promise.all(parte.map(u => puntaje(semilla, u)));
      for (let j = 0; j < parte.length; j++) puntajes.push({ usuario: parte[j], puntaje: hs[j] });
      if (onProgreso) onProgreso(Math.min(i + LOTE, lista.length), lista.length);
    }
    puntajes.sort((a, b) => (a.puntaje < b.puntaje ? -1 : a.puntaje > b.puntaje ? 1 : (a.usuario < b.usuario ? -1 : 1)));
    const nG = Math.max(0, Number(nGanadores) || 0), nS = Math.max(0, Number(nSuplentes) || 0);
    return {
      semilla,
      orden: puntajes,
      ganadores: puntajes.slice(0, nG).map(p => p.usuario),
      suplentes: puntajes.slice(nG, nG + nS).map(p => p.usuario)
    };
  }

  // Código del sorteo: huella del resultado completo, para publicar y comparar.
  async function codigoResultado(d) {
    return sha256([
      String(d.hashLista || "").toLowerCase(), String(d.cadena || "quicknet"), String(d.ronda),
      String(d.semilla || "").toLowerCase(), (d.ganadores || []).join(","), (d.suplentes || []).join(",")
    ].join("|"));
  }

  function clasificarFallas(fallas) {
    const errs = (fallas || []).map(f => String(f.error || ""));
    if (errs.length && errs.every(e => /HTTP (404|425)/.test(e))) return "no-publicada";
    if (errs.length && errs.every(e => /timeout|fetch|network|conexi/i.test(e))) return "sin-conexion";
    return "mixto";
  }

  async function consultarEspejo(espejo, ronda, cadena, timeoutMs, fetchFn) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = setTimeout(() => { if (ctrl) ctrl.abort(); }, timeoutMs);
    try {
      const r = await fetchFn(urlRonda(ronda, cadena, espejo), { signal: ctrl ? ctrl.signal : undefined, cache: "no-store" });
      if (!r.ok) return { espejo, error: "HTTP " + r.status };
      const j = await r.json();
      if (Number(j.round) !== Number(ronda)) return { espejo, error: "devolvió otra ronda (" + j.round + ")" };
      const rnd = String(j.randomness || "").toLowerCase();
      if (!esHex64(rnd)) return { espejo, error: "randomness inválida" };
      return { espejo, ronda: Number(j.round), randomness: rnd, signature: String(j.signature || "") };
    } catch (e) {
      return { espejo, error: (e && e.name === "AbortError") ? "timeout" : String((e && e.message) || e) };
    } finally { clearTimeout(t); }
  }

  // Pide la ronda a todos los espejos a la vez, reintenta una vez los que fallaron y exige que coincidan.
  async function obtenerRonda(ronda, opciones) {
    const o = opciones || {};
    const cadena = o.cadena || CADENAS.quicknet;
    const espejos = o.espejos || ESPEJOS;
    const timeoutMs = o.timeoutMs || 8000;
    const fetchFn = o.fetchFn || globalThis.fetch;
    const esperaReintento = o.esperaReintento === undefined ? 1500 : o.esperaReintento;
    let resultados = await Promise.all(espejos.map(e => consultarEspejo(e, ronda, cadena, timeoutMs, fetchFn)));
    const fallados = resultados.filter(r => r.error).map(r => r.espejo);
    if (fallados.length && fallados.length < espejos.length && esperaReintento >= 0) {
      await new Promise(r => setTimeout(r, esperaReintento));
      const segunda = await Promise.all(fallados.map(e => consultarEspejo(e, ronda, cadena, timeoutMs, fetchFn)));
      resultados = resultados.map(r => r.error ? segunda.find(s => s.espejo === r.espejo) || r : r);
    }
    const ok = resultados.filter(r => r.randomness);
    if (!ok.length) {
      const err = new Error("Ninguna fuente de drand devolvió la ronda " + ronda + ".");
      err.detalles = resultados; err.sinRespuesta = true; err.motivo = clasificarFallas(resultados); throw err;
    }
    if (new Set(ok.map(r => r.randomness)).size > 1) { const err = new Error("Las fuentes de drand no coinciden entre sí."); err.detalles = resultados; err.motivo = "desacuerdo"; throw err; }
    const firma = ok[0].signature;
    // En quicknet (esquema "unchained"), randomness = SHA-256(firma). Es un chequeo de consistencia interna:
    // NO verifica la firma BLS contra la clave pública de la cadena.
    let firmaCoincide = null;
    if (/^[0-9a-f]+$/i.test(firma) && firma.length % 2 === 0) {
      try { firmaCoincide = (await sha256Bytes(deHex(firma.toLowerCase()))) === ok[0].randomness; } catch (e) { firmaCoincide = null; }
    }
    return {
      ronda: Number(ronda), randomness: ok[0].randomness, signature: firma,
      fuentes: ok.map(r => r.espejo), fallas: resultados.filter(r => r.error), firmaCoincide
    };
  }

  // Ancla externa: la fecha del deploy de GitHub Pages la pone GitHub, no quien commitea.
  // Busca el deploy MÁS ANTIGUO cuyo sorteo.json ya tenía esta huella y esta ronda.
  async function anclaGitHub(repo, hashLista, ronda, opciones) {
    const m = String(repo || "").match(/github\.com\/([^\/]+)\/([^\/#?]+)/);
    if (!m) return null;
    const owner = m[1], name = m[2].replace(/\.git$/, "");
    const fetchFn = (opciones && opciones.fetchFn) || globalThis.fetch;
    const maximo = (opciones && opciones.maximo) || 30;
    const r = await fetchFn("https://api.github.com/repos/" + owner + "/" + name + "/deployments?environment=github-pages&per_page=" + maximo, { headers: { accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error("GitHub respondió HTTP " + r.status);
    const deps = await r.json();
    if (!Array.isArray(deps)) throw new Error("GitHub devolvió algo inesperado");
    const checks = await Promise.all(deps.map(async d => {
      try {
        const rr = await fetchFn("https://raw.githubusercontent.com/" + owner + "/" + name + "/" + d.sha + "/sorteo.json", { cache: "no-store" });
        if (!rr.ok) return null;
        const c = await rr.json();
        const coincide = String(c.participantesSha256 || "").toLowerCase() === String(hashLista).toLowerCase() && Number(c.ronda) === Number(ronda);
        return coincide ? { sha: d.sha, creado: new Date(d.created_at), url: "https://github.com/" + owner + "/" + name + "/commit/" + d.sha } : null;
      } catch (e) { return null; }
    }));
    const coinciden = checks.filter(Boolean).sort((a, b) => a.creado - b.creado);
    return { deploys: deps.length, coinciden: coinciden.length, primero: coinciden[0] || null, urlDeploys: "https://github.com/" + owner + "/" + name + "/deployments" };
  }
  // Fecha de una captura de Internet Archive, sacada de su propia URL (/web/AAAAMMDDhhmmss/...).
  function fechaWayback(url) {
    const m = String(url || "").match(/web\.archive\.org\/web\/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
  }

  return {
    CADENAS, ESPEJOS, REGEX_FECHA, sha256, normalizarUsuario, esHex64, esUsuarioIG, validarLista, hashLista, hashEvidencia,
    rondaParaFecha, esMinutoEnPunto, fechaDeRonda, urlRonda, shortcodeDeReel, urlComentario, puntaje, sortear, codigoResultado,
    clasificarFallas, obtenerRonda, anclaGitHub, fechaWayback
  };
});
