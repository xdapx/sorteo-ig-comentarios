#!/usr/bin/env node
/*
  Reproduce el sorteo desde cero, con el mismo algoritmo que las páginas (sorteo-core.js).
  Corta con error (exit 1) si algo no cierra: lista inválida, huella distinta, ronda que no
  corresponde a la fecha, semilla inválida.
  Uso:
    node verificar.js                    -> usa sorteo.json + participantes.json y consulta drand
    node verificar.js --semilla <hex>    -> usa esa semilla en vez de consultar drand
    node verificar.js --codigo <hex>     -> compara con el código del sorteo publicado
    node verificar.js --usuario <nombre> -> además muestra en qué puesto quedó ese usuario
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
const fmt = d => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);

(async () => {
  const o = args(), dir = __dirname;
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "sorteo.json"), "utf8"));
  const padron = JSON.parse(fs.readFileSync(path.join(dir, cfg.participantes || "participantes.json"), "utf8"));
  const cadena = Core.CADENAS[cfg.cadena || "quicknet"];
  if (!cadena) salir("cadena desconocida: " + cfg.cadena);
  const usuarios = padron.usuarios;
  if (cfg.prueba) console.log("*** sorteo.json está marcado como PRUEBA LOCAL ***");

  try { Core.validarLista(usuarios); } catch (e) { salir("la lista no es válida: " + e.message); }
  const hash = await Core.hashLista(usuarios);
  console.log("Boletos:            " + usuarios.length.toLocaleString("es-AR") + "  (" + new Set(usuarios.map(Core.usuarioDe)).size.toLocaleString("es-AR") + " personas)");
  console.log("Huella calculada:   " + hash);
  if (hash !== String(padron.sha256 || "").toLowerCase()) salir("la huella no coincide con participantes.json (" + padron.sha256 + ")");
  if (hash !== String(cfg.participantesSha256 || "").toLowerCase()) salir("la huella no coincide con sorteo.json (" + cfg.participantesSha256 + ")");
  console.log("  == participantes.json y sorteo.json: SI");

  // Criterio "menos likes": rehace el filtro desde likes.json y comprueba que el padrón sea exactamente
  // el conjunto de usuarios que tenían el mínimo de likes. Sin esto habría que creerle al organizador.
  if (cfg.criterio === "menos-likes") {
    const likesPath = path.join(dir, cfg.likes || "likes.json");
    if (!fs.existsSync(likesPath)) salir("sorteo.json dice criterio 'menos-likes' pero falta " + (cfg.likes || "likes.json") + ": sin eso no se puede comprobar el filtro.");
    const lk = JSON.parse(fs.readFileSync(likesPath, "utf8"));
    const filasLk = Array.isArray(lk.filas) ? lk.filas : [];
    if (!filasLk.length) salir("likes.json no tiene filas.");
    const hashLikes = await Core.sha256(filasLk.map(r => r.join("\t") + "\n").join(""));
    console.log("Likes publicados:   " + filasLk.length.toLocaleString("es-AR") + " comentarios · huella " + hashLikes);
    if (hashLikes !== String(lk.sha256 || "").toLowerCase()) salir("la huella de likes.json no coincide con la que declara el propio archivo (" + lk.sha256 + ")");
    if (cfg.likesSha256 && hashLikes !== String(cfg.likesSha256).toLowerCase()) salir("la huella de likes.json no coincide con sorteo.json (" + cfg.likesSha256 + ")");
    const excl = new Set(((padron.criterio || {}).excluidos) || []);
    const elegibles = filasLk.filter(r => !excl.has(Core.normalizarUsuario(r[1])));
    if (!elegibles.length) salir("después de las exclusiones no queda ningún comentario en likes.json");
    let min = Infinity;
    for (const r of elegibles) { const n = Number(r[2]); if (!Number.isInteger(n) || n < 0) salir("likes inválidos en likes.json: " + JSON.stringify(r)); if (n < min) min = n; }
    if (cfg.minLikes != null && Number(cfg.minLikes) !== min) salir("sorteo.json dice minLikes=" + cfg.minLikes + " pero en likes.json el mínimo es " + min);
    const esperados = [...new Set(elegibles.filter(r => Number(r[2]) === min).map(r => Core.normalizarUsuario(r[1])))].sort();
    const iguales = esperados.length === usuarios.length && esperados.every((u, i) => u === usuarios[i]);
    console.log("Criterio menos likes: mínimo " + min + " like" + (min === 1 ? "" : "s") + " · " + elegibles.filter(r => Number(r[2]) === min).length.toLocaleString("es-AR") + " comentarios · " + esperados.length.toLocaleString("es-AR") + " personas");
    if (!iguales) {
      const sobran = usuarios.filter(u => !esperados.includes(u)), faltan = esperados.filter(u => !usuarios.includes(u));
      salir("el padrón no es el que sale de likes.json" + (sobran.length ? " · de más: " + sobran.slice(0, 5).join(", ") : "") + (faltan.length ? " · de menos: " + faltan.slice(0, 5).join(", ") : ""));
    }
    console.log("  == el padrón es exactamente ese conjunto: SI");
  }

  let ronda;
  try { ronda = Core.rondaParaFecha(cfg.fechaSorteo, cadena); } catch (e) { salir("fechaSorteo: " + e.message); }
  if (Number(cfg.ronda) !== ronda) salir("sorteo.json dice ronda #" + cfg.ronda + " pero la fecha anunciada (" + cfg.fechaSorteo + ") corresponde a la #" + ronda);
  const fechaRonda = Core.fechaDeRonda(ronda, cadena);
  console.log("Ronda drand:        #" + ronda + "  = " + fmt(fechaRonda) + " hs Argentina (" + fechaRonda.toISOString() + ")");
  console.log("                    " + Core.urlRonda(ronda, cadena));
  if (padron.generado && Date.parse(padron.generado) >= fechaRonda.getTime()) console.log("AVISO: la lista se generó DESPUÉS de la ronda (" + padron.generado + "). Un sorteo real así no vale.");

  let semilla;
  if (o.semilla) {
    semilla = String(o.semilla).toLowerCase();
    if (!Core.esHex64(semilla)) salir("Semilla inválida: se esperan 64 caracteres hexadecimales.");
    console.log("Semilla (manual):   " + semilla);
  } else {
    const r = await Core.obtenerRonda(ronda, { cadena });
    semilla = r.randomness;
    console.log("Semilla:            " + semilla);
    console.log("Fuentes que coinciden: " + r.fuentes.length + "/" + Core.ESPEJOS.length + (r.fallas.length ? "  (fallaron: " + r.fallas.map(f => f.espejo + " " + f.error).join("; ") + ")" : ""));
    if (r.fuentes.length < 2) console.log("AVISO: respondió una sola fuente; cotejá la semilla en otro espejo de drand.");
    console.log("Consistencia randomness == SHA-256(firma): " + (r.firmaCoincide === null ? "no verificable" : r.firmaCoincide ? "SI" : "NO") + "  (no verifica la firma BLS)");
  }
  const res = await Core.sortear(usuarios, semilla, cfg.ganadores, cfg.suplentes);
  console.log("\nGANADORES (" + cfg.ganadores + "):");
  res.ganadores.forEach((u, i) => console.log("  " + (i + 1) + ". @" + u));
  console.log("SUPLENTES (" + cfg.suplentes + "):");
  res.suplentes.forEach((u, i) => console.log("  " + (i + 1) + ". @" + u));
  const codigo = await Core.codigoResultado({ hashLista: hash, cadena: cadena.id, ronda, semilla, ganadores: res.ganadores, suplentes: res.suplentes });
  console.log("\nCODIGO DEL SORTEO:  " + codigo);
  if (o.codigo) {
    const igual = String(o.codigo).toLowerCase() === codigo;
    console.log("  == codigo publicado: " + (igual ? "SI" : "NO"));
    if (!igual) process.exitCode = 1;
  }
  if (o.usuario) {
    const u = Core.normalizarUsuario(o.usuario);
    const pos = res.orden.findIndex(p => p.usuario === u);
    console.log("\n@" + u + ": " + (pos < 0 ? "no está en el padrón" : "puesto " + (pos + 1) + " de " + res.orden.length));
  }
  // Ancla externa (informativa): cuándo publicó GitHub Pages esta huella + ronda.
  if (cfg.repo && !o.semilla) {
    try {
      const a = await Core.anclaGitHub(cfg.repo, hash, ronda);
      if (a && a.primero) console.log("\nPublicado en GitHub Pages el " + fmt(a.primero.creado) + " hs (" + (a.primero.creado < fechaRonda ? "ANTES" : "DESPUÉS") + " de la ronda) — " + a.primero.url);
      else if (a) console.log("\nGitHub Pages: no encontré un deploy con esta huella y esta ronda (" + a.deploys + " deploys revisados).");
    } catch (e) { console.log("\nGitHub Pages: no se pudo consultar (" + e.message + ")"); }
  }
})().catch(e => { console.error("ERROR: " + e.message); if (e.detalles) console.error(JSON.stringify(e.detalles, null, 2)); process.exit(1); });
