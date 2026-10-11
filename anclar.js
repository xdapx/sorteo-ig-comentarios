#!/usr/bin/env node
/*
  Registra en sorteo.json las anclas externas que prueban que la lista existió ANTES de la ronda:
    node anclar.js --wayback                 -> pide a Internet Archive una captura de participantes.json y sorteo.json
                                                (tal como los sirve GitHub Pages) y guarda las URLs en sorteo.json
    node anclar.js --anuncio <URL>           -> guarda el link del posteo / comentario fijado de Instagram con la huella y la ronda
    node anclar.js --pages <URL base>        -> cambia la URL pública (por defecto la de sorteo.json: campo "pages")
  Después de correrlo hay que commitear y pushear sorteo.json de nuevo (la huella de la lista no cambia).
*/
"use strict";
const fs = require("fs");
const path = require("path");
const Core = require("./sorteo-core.js");

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const k = a[i].slice(2);
    o[k] = (i + 1 < a.length && !a[i + 1].startsWith("--")) ? a[++i] : true;
  }
  return o;
}
function salir(msg) { console.error("ERROR: " + msg); process.exit(1); }

async function capturar(url) {
  // GET https://web.archive.org/save/<url> devuelve la captura (sigue redirecciones hasta /web/AAAAMMDDhhmmss/<url>).
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch("https://web.archive.org/save/" + url, { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": "sorteo-anclar/1.0" } });
    const candidatos = [r.url, r.headers.get("content-location"), r.headers.get("location")].filter(Boolean)
      .map(u => u.startsWith("/") ? "https://web.archive.org" + u : u);
    const ok = candidatos.find(u => Core.fechaWayback(u));
    if (!ok) throw new Error("Internet Archive respondió HTTP " + r.status + " sin URL de captura (" + candidatos.join(" | ") + ")");
    return ok;
  } finally { clearTimeout(t); }
}

(async () => {
  const o = args();
  const cfgPath = path.join(__dirname, "sorteo.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  if (cfg.prueba) salir("sorteo.json está marcado como PRUEBA (--forzar). Corré preparar.js sin --forzar antes de anclar.");
  if (o.pages) cfg.pages = String(o.pages);
  if (!cfg.archivo) cfg.archivo = { participantes: "", sorteo: "" };
  let cambios = 0;

  if (o.anuncio) {
    if (!/^https:\/\/(www\.)?instagram\.com\//.test(String(o.anuncio))) salir("--anuncio tiene que ser un link de instagram.com (posteo o comentario).");
    cfg.anuncio = String(o.anuncio); cambios++;
    console.log("Anuncio registrado: " + cfg.anuncio);
  }

  if (o.wayback) {
    const base = String(cfg.pages || "").replace(/\/?$/, "/");
    if (!/^https:\/\//.test(base)) salir("Falta la URL pública (campo \"pages\" en sorteo.json o --pages).");
    // Antes de archivar, confirmar que Pages ya sirve ESTA versión (huella + ronda), no una vieja en caché.
    const r = await fetch(base + "sorteo.json?v=" + String(cfg.participantesSha256).slice(0, 8), { cache: "no-store" });
    if (!r.ok) salir("No pude leer " + base + "sorteo.json (HTTP " + r.status + "). ¿Ya se pusheó y terminó el deploy?");
    const vivo = await r.json();
    if (vivo.participantesSha256 !== cfg.participantesSha256 || Number(vivo.ronda) !== Number(cfg.ronda)) salir("Lo que sirve GitHub Pages todavía no es esta versión (huella " + String(vivo.participantesSha256).slice(0, 8) + "…, ronda #" + vivo.ronda + "). Esperá el deploy (hasta 10 minutos por la caché) y volvé a correr.");
    const faltan = Core.fechaDeRonda(cfg.ronda).getTime() - Date.now();
    if (faltan <= 0) salir("La ronda #" + cfg.ronda + " ya salió: una captura de ahora no prueba nada.");
    for (const [k, archivo] of [["participantes", cfg.participantes || "participantes.json"], ["sorteo", "sorteo.json"]]) {
      process.stdout.write("Pidiendo captura de " + archivo + " a Internet Archive… ");
      const u = await capturar(base + archivo);
      cfg.archivo[k] = u; cambios++;
      console.log("OK\n  " + u + "\n  fecha de la captura: " + Core.fechaWayback(u).toISOString());
    }
  }

  if (!cambios) salir("No hiciste nada: usá --wayback y/o --anuncio <URL>.");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  console.log("\nsorteo.json actualizado. Ahora: git add sorteo.json && git commit -m \"Anclas del sorteo\" && git push");
})().catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
