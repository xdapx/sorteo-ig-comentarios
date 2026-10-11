#!/usr/bin/env node
/*
  Arma el padrón del sorteo (participantes.json + evidencia.json) a partir del CSV de comentarios,
  y deja sorteo.json listo (huella del padrón + ronda de drand para la fecha elegida).

  Uso:
    node preparar.js --csv comentarios.csv --fecha "2026-09-05T20:00:00-03:00"
                     [--menos-likes] [--mencion] [--excluir usuario1,usuario2] [--reel URL] [--media ID] [--forzar]

  --fecha       OBLIGATORIA. Fecha y hora del sorteo, ISO con zona horaria (-03:00 es Argentina), minuto en punto.
                De acá sale la ronda de drand. Tiene que faltar al menos 1 hora (idealmente 24 h): la lista se
                publica y se anuncia ANTES de que exista el número al azar; si no, el sorteo no vale.
  --forzar      Solo para pruebas locales: acepta fechas pasadas o cercanas y marca la configuración como PRUEBA.
  --menos-likes Solo entran los comentarios con MENOS likes (el mínimo que haya en el reel al momento del corte).
                Es el criterio anunciado en el reel del Alpine: "el comentario con menos likes se lleva el premio,
                y si hay más de uno con cero likes se sortea entre ellos". Publica likes.json con la cantidad de
                likes de TODOS los comentarios, para que cualquiera pueda comprobar el mínimo y quiénes lo tenían.
  --por-comentario  Cada comentario es una chance: el padrón lleva un boleto "usuario#n" por cada comentario
                (n = el n-ésimo de esa persona por fecha; el id va en evidencia.json). Igual cada persona sale
                una sola vez: el sorteo se queda con su mejor boleto. No se combina con --menos-likes.
  --mencion     Solo entran los usuarios que en algún comentario etiquetaron a alguien (@alguien).
  --excluir     Usuarios que no participan (el dueño de la cuenta, el equipo, etc.).
  --corte       Fecha y hora límite de los comentarios, ISO con zona horaria. Los posteriores no cuentan.
                Es la fecha que se anunció como cierre; si no se pasa, el corte es el último comentario del CSV.
  --con-respuestas  Cuenta también las respuestas dentro de un hilo (columna respuesta_a del CSV).
                Por defecto NO entran: el edge /comments de Instagram solo devuelve comentarios de
                primer nivel, así que es lo que se anunció en los sorteos anteriores. Que entren o no
                cambia el padrón, así que se decide a mano y se dice en las bases.
*/
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Core = require("./sorteo-core.js");

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const k = a[i].slice(2);
    if (i + 1 < a.length && !a[i + 1].startsWith("--")) { o[k] = a[++i]; } else o[k] = true;
  }
  return o;
}
function parseCSV(texto) {
  const filas = []; let fila = [], campo = "", enComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else enComillas = false; }
      else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      fila.push(campo); filas.push(fila); fila = []; campo = "";
    } else campo += c;
  }
  if (campo.length || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter(f => f.length > 1 || (f.length === 1 && f[0] !== ""));
}
function salir(msg) { console.error("ERROR: " + msg); process.exit(1); }
const fmt = d => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);

(async () => {
  const o = args();
  const dir = __dirname;
  const csvPath = path.resolve(dir, o.csv || "comentarios.csv");
  const cfgPath = path.join(dir, "sorteo.json");
  const outPath = path.join(dir, "participantes.json");
  const eviPath = path.join(dir, "evidencia.json");
  const likesPath = path.join(dir, "likes.json");
  if (!fs.existsSync(csvPath)) salir("No encuentro el CSV: " + csvPath);
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
  cfg.cadena = cfg.cadena || "quicknet";
  const cadena = Core.CADENAS[cfg.cadena];
  if (!cadena) salir("Cadena desconocida en sorteo.json: " + cfg.cadena);

  // 1) La fecha: obligatoria, ISO con zona, minuto en punto, con margen. Se valida ANTES de escribir nada.
  if (!o.fecha || o.fecha === true) salir('Falta --fecha "AAAA-MM-DDTHH:MM:00-03:00" (hora del sorteo, con zona horaria). A propósito no se hereda la fecha anterior.');
  let ronda;
  try { ronda = Core.rondaParaFecha(o.fecha, cadena); } catch (e) { salir(e.message); }
  if (!Core.esMinutoEnPunto(o.fecha)) salir("Usá minuto en punto (segundos :00), ej. 20:00:00-03:00. La gente lee la hora en minutos: la ronda tiene que ser la del minuto anunciado.");
  const fechaRonda = Core.fechaDeRonda(ronda, cadena);
  const faltanMs = fechaRonda.getTime() - Date.now();
  const prueba = !!o.forzar;
  if (faltanMs < 3600e3 && !prueba) salir("La ronda #" + ronda + (faltanMs < 0 ? " YA SALIÓ" : " sale en menos de 1 hora") + " (" + fmt(fechaRonda) + " hs). La lista tiene que publicarse y anunciarse ANTES, idealmente 24 h. Para pruebas locales usá --forzar.");
  if (faltanMs < 24 * 3600e3 && !prueba) console.warn("AVISO: faltan menos de 24 h para la ronda. Cuanto antes se publique y anuncie la lista, más fuerte es la prueba.");

  // 2) El CSV
  const csvBytes = fs.readFileSync(csvPath);
  const csvSha256 = crypto.createHash("sha256").update(csvBytes).digest("hex");
  const filas = parseCSV(csvBytes.toString("utf8").replace(/^﻿/, ""));
  const cab = filas.shift().map(s => s.trim().toLowerCase());
  const col = n => cab.indexOf(n);
  const iU = col("username"), iT = col("text"), iF = col("timestamp"), iI = col("id"), iL = col("like_count"), iR = col("respuesta_a");
  const conRespuestas = !!o["con-respuestas"];
  if (conRespuestas && iR < 0) salir("--con-respuestas necesita la columna 'respuesta_a' y el CSV no la tiene. Volvé a bajar los comentarios con sorteo_ig.py.");
  let descartadasRespuestas = 0;
  if (iU < 0) salir("El CSV no tiene columna 'username'. Cabecera: " + cab.join(","));
  const menosLikes = !!o["menos-likes"];
  const porComentario = !!o["por-comentario"];
  if (porComentario && menosLikes) salir("--por-comentario y --menos-likes no se combinan.");
  if (menosLikes && iL < 0) salir("--menos-likes necesita la columna 'like_count' y el CSV no la tiene. Volvé a bajar los comentarios con index.html o sorteo_ig.py. Cabecera: " + cab.join(","));
  if (menosLikes && iI < 0) salir("--menos-likes necesita la columna 'id': cada comentario tiene que ser identificable para poder mostrarlo.");

  const excluidos = new Set(String(o.excluir || "").split(",").map(Core.normalizarUsuario).filter(Boolean));
  const requiereMencion = !!o.mencion;
  // Corte anunciado: los comentarios posteriores no cuentan. Sin esto, "hasta ayer" quedaría a merced
  // de la hora en que se bajó el CSV, y los comentarios de último momento entran sin que nadie
  // haya tenido tiempo de likearlos — que en un sorteo de "menos likes" es ganar por llegar tarde.
  let corteLimite = null;
  if (o.corte && o.corte !== true) {
    if (!Core.REGEX_FECHA.test(String(o.corte))) salir('--corte necesita formato ISO con zona horaria, ej. "2026-08-30T23:59:59-03:00" (recibí: ' + o.corte + ")");
    corteLimite = Date.parse(o.corte);
    if (!isFinite(corteLimite)) salir("--corte inválido: " + o.corte);
  }
  let descartadosPorCorte = 0;
  const porUsuario = new Map(); // usuario -> {comentarios, menciona, primero: {id, ts}}
  const todosComentarios = [];  // {u, id, ts, likes} — uno por comentario, para el criterio de likes y para likes.json
  const invalidos = [];
  let corte = "", totalComentarios = 0;
  for (const f of filas) {
    const u = Core.normalizarUsuario(f[iU]);
    if (!u) continue;
    if (!Core.esUsuarioIG(u)) { invalidos.push(f[iU]); continue; }
    if (iR >= 0 && String(f[iR] || "").trim() && !conRespuestas) { descartadasRespuestas++; continue; }
    totalComentarios++;
    const ts = iF >= 0 ? String(f[iF] || "").trim() : "";
    if (ts && (isNaN(Date.parse(ts)) || !/^\d{4}-\d{2}-\d{2}T/.test(ts))) salir("Timestamp inválido en el CSV (se espera ISO, ej. 2026-07-10T18:32:56+0000): " + ts);
    if (corteLimite !== null && ts && Date.parse(ts) > corteLimite) { descartadosPorCorte++; totalComentarios--; continue; }
    if (ts && (!corte || Date.parse(ts) > Date.parse(corte))) corte = ts;
    const e = porUsuario.get(u) || { comentarios: 0, menciona: false, primero: null };
    e.comentarios++;
    if (iT >= 0 && /(^|[^A-Za-z0-9_.])@[A-Za-z0-9._]{1,30}/.test(f[iT] || "")) e.menciona = true;
    const id = iI >= 0 ? String(f[iI] || "").trim() : "";
    if (!e.primero || (ts && e.primero.ts && Date.parse(ts) < Date.parse(e.primero.ts))) e.primero = { id, ts };
    porUsuario.set(u, e);
    let likes = 0;
    if (iL >= 0) {
      const crudo = String(f[iL] == null ? "" : f[iL]).trim();
      likes = crudo === "" ? 0 : Number(crudo);
      if (!Number.isInteger(likes) || likes < 0) salir("like_count inválido en el CSV (se espera un entero >= 0): " + JSON.stringify(f[iL]));
    }
    todosComentarios.push({ u, id, ts, likes });
  }
  if (invalidos.length) salir("El CSV trae usuarios con caracteres que Instagram no permite (¿archivo tocado a mano?): " + invalidos.slice(0, 5).map(x => JSON.stringify(x)).join(", ") + (invalidos.length > 5 ? " y " + (invalidos.length - 5) + " más" : ""));
  const todos = [...porUsuario.keys()];
  const conMencion = todos.filter(u => porUsuario.get(u).menciona).length;
  const elegible = u => !excluidos.has(u) && (!requiereMencion || porUsuario.get(u).menciona);

  // El padrón. Con --menos-likes entran solo los comentarios que tienen la menor cantidad de likes del reel
  // (el mínimo real al momento del corte, casi siempre 0); sin la opción, entra todo el que haya comentado.
  let usuarios, minLikes = null, candidatos = [];
  const comentarios = {};
  if (menosLikes) {
    const elegibles = todosComentarios.filter(c => elegible(c.u));
    if (!elegibles.length) salir("No quedó ningún comentario después de aplicar las exclusiones" + (requiereMencion ? " y el criterio de mención" : "") + ".");
    minLikes = Infinity;
    for (const c of elegibles) if (c.likes < minLikes) minLikes = c.likes;
    candidatos = elegibles.filter(c => c.likes === minLikes);
    const mejor = new Map(); // por usuario, el más antiguo de sus comentarios con el mínimo de likes
    for (const c of candidatos) {
      const p = mejor.get(c.u);
      if (!p || (c.ts && (!p.ts || Date.parse(c.ts) < Date.parse(p.ts)))) mejor.set(c.u, c);
    }
    usuarios = [...mejor.keys()].sort();
    for (const u of usuarios) { const c = mejor.get(u); comentarios[u] = { id: c.id, ts: c.ts, likes: c.likes }; }
  } else if (porComentario) {
    // Un boleto por comentario: usuario#1 es su comentario más viejo, usuario#2 el siguiente, etc.
    usuarios = [];
    const deCada = new Map();
    for (const c of todosComentarios) if (elegible(c.u)) (deCada.get(c.u) || deCada.set(c.u, []).get(c.u)).push(c);
    for (const u of [...deCada.keys()].sort()) {
      const cs = deCada.get(u).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
      cs.forEach((c, i) => { const b = u + "#" + (i + 1); usuarios.push(b); comentarios[b] = { id: c.id, ts: c.ts }; });
    }
  } else {
    usuarios = todos.filter(elegible).sort();
    for (const u of usuarios) comentarios[u] = porUsuario.get(u).primero || { id: "", ts: "" };
  }
  const personas = new Set(usuarios.map(Core.usuarioDe)).size;
  Core.validarLista(usuarios);
  const sha256 = await Core.hashLista(usuarios);
  const evidenciaSha256 = await Core.hashEvidencia(usuarios, comentarios);

  // 3) participantes.json: metadatos legibles arriba, la lista de usuarios uno por línea abajo.
  const meta = {
    reel: o.reel || cfg.reel || "",
    mediaId: o.media || cfg.mediaId || "",
    generado: new Date().toISOString(),
    corte,
    corteAnunciado: corteLimite !== null ? o.corte : "",
    descartadosPorCorte,
    comentarios: totalComentarios,
    usuariosUnicos: todos.length,
    criterio: {
      unaEntradaPorUsuario: true,
      cuentanRespuestas: conRespuestas,
      menosLikes,
      porComentario,
      minLikes: menosLikes ? minLikes : null,
      comentariosCandidatos: menosLikes ? candidatos.length : null,
      requiereMencion,
      excluidos: [...excluidos].sort(),
      descripcion: (menosLikes
        ? "Entran solo los comentarios con MENOS likes del reel: los que tenían " + minLikes + " like" + (minLikes === 1 ? "" : "s") +
          " al momento del corte (" + candidatos.length.toLocaleString("es-AR") + " comentarios de " + totalComentarios.toLocaleString("es-AR") +
          "). La cantidad de likes de todos los comentarios está publicada en likes.json. Una entrada por persona, aunque haya dejado varios comentarios sin likes"
        : porComentario
          ? "Cada comentario es una chance (" + usuarios.length.toLocaleString("es-AR") + " comentarios de " + personas.toLocaleString("es-AR") +
            " personas), pero cada persona puede salir una sola vez: si ya salió, sus otros comentarios no cuentan para los puestos siguientes"
        : "Una entrada por usuario, sin importar cuántos comentarios haya dejado") +
        (requiereMencion ? ", y solo si etiquetó a alguien en algún comentario" : "") + "."
    },
    hashDefinicion: "SHA-256 del texto formado por cada usuario seguido de un salto de línea, en este orden.",
    sha256,
    participantes: personas,
    boletos: usuarios.length,
    // Números a la vista: la transparencia se lee mejor en un tablero que en un párrafo.
    resumen: (() => {
      const elegibles = todosComentarios.filter(c => elegible(c.u));
      const conLikes = iL >= 0 ? elegibles : [];
      const reparto = {};
      for (const c of conLikes) reparto[c.likes] = (reparto[c.likes] || 0) + 1;
      let top = null;
      for (const c of conLikes) if (!top || c.likes > top.likes || (c.likes === top.likes && c.ts && top.ts && Date.parse(c.ts) < Date.parse(top.ts))) top = c;
      const ceros = conLikes.filter(c => c.likes === 0);
      return {
        comentarios: totalComentarios,
        comentariosElegibles: elegibles.length,
        personasQueComentaron: todos.length,
        sinLikes: ceros.length,
        personasSinLikes: new Set(ceros.map(c => c.u)).size,
        minLikes: menosLikes ? minLikes : null,
        enElMinimo: menosLikes ? candidatos.length : null,
        participantes: personas,
        boletos: porComentario ? usuarios.length : null,
        masLikes: top ? { usuario: top.u, likes: top.likes, id: top.id, ts: top.ts } : null,
        reparto: Object.keys(reparto).map(Number).sort((a, b) => a - b).map(k => [k, reparto[k]])
      };
    })()
  };
  const cuerpo = JSON.stringify(meta, null, 2).replace(/\n}$/, ",\n  \"usuarios\": [\n" +
    usuarios.map(u => "    " + JSON.stringify(u)).join(",\n") + "\n  ]\n}\n");
  fs.writeFileSync(outPath, cuerpo, "utf8");

  // 4) evidencia.json: id y fecha del comentario con el que entró cada usuario (para linkearlo en el reel).
  fs.writeFileSync(eviPath, JSON.stringify({
    reel: meta.reel, mediaId: meta.mediaId, generado: meta.generado, csvSha256,
    hashDefinicion: "SHA-256 del texto formado por usuario, tab, id, tab, timestamp y salto de línea, por cada usuario en el orden de participantes.json.",
    definicion: menosLikes
      ? "Por cada participante, el comentario con el que entró: el más antiguo de los suyos que tenía " + minLikes + " like" + (minLikes === 1 ? "" : "s") + " (el mínimo del reel) al momento del corte."
      : porComentario ? "Por cada boleto usuario#n, el comentario al que corresponde: el n-ésimo de esa persona, ordenados por fecha."
      : "Por cada participante, su primer comentario en el reel.",
    sha256: evidenciaSha256, comentarios
  }, null, 1) + "\n", "utf8");

  // 4bis) likes.json: los likes de TODOS los comentarios al corte, para que cualquiera compruebe cuál era el
  // mínimo y quiénes lo tenían. Sin el texto de los comentarios (eso queda en el CSV, que no se publica).
  let likesSha256 = "";
  if (menosLikes) {
    const filasLikes = todosComentarios
      .map(c => [c.id, c.u, c.likes, c.ts])
      .sort((a, b) => a[2] - b[2] || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    likesSha256 = crypto.createHash("sha256").update(Buffer.from(filasLikes.map(r => r.join("\t") + "\n").join(""), "utf8")).digest("hex");
    const metaLikes = {
      reel: meta.reel, mediaId: meta.mediaId, generado: meta.generado, corte,
      definicion: "Likes de cada comentario del reel al momento del corte. Cada fila es [id, usuario, likes, fecha].",
      hashDefinicion: "SHA-256 del texto formado por id, tab, usuario, tab, likes, tab, fecha y salto de línea, por cada fila en este orden.",
      comentarios: totalComentarios, minLikes, candidatos: candidatos.length, participantes: usuarios.length,
      sha256: likesSha256
    };
    fs.writeFileSync(likesPath, JSON.stringify(metaLikes, null, 2).replace(/\n}$/, ",\n  \"filas\": [\n" +
      filasLikes.map(r => "    " + JSON.stringify(r)).join(",\n") + "\n  ]\n}\n"), "utf8");

    // Ayuda para el premio al comentario MÁS creativo/con más likes: no se sortea, lo elige el organizador.
    const top = todosComentarios.filter(c => elegible(c.u)).sort((a, b) => b.likes - a.likes).slice(0, 50);
    fs.writeFileSync(path.join(dir, "mas-likes.txt"),
      "Comentarios con MÁS likes (para elegir a mano el premio al más creativo). No se publica.\n" +
      "Corte: " + (corte ? fmt(new Date(corte)) + " hs" : "—") + "\n\n" +
      top.map((c, i) => String(i + 1).padStart(3) + ". " + String(c.likes).padStart(6) + " likes  @" + c.u + "  " + (Core.urlComentario(meta.reel, c.id) || c.id)).join("\n") + "\n", "utf8");
  }

  // 5) sorteo.json
  cfg.participantes = "participantes.json";
  cfg.participantesSha256 = sha256;
  cfg.evidencia = "evidencia.json";
  cfg.evidenciaSha256 = evidenciaSha256;
  cfg.csvSha256 = csvSha256;
  cfg.criterio = menosLikes ? "menos-likes" : porComentario ? "por-comentario" : "todos";
  cfg.minLikes = menosLikes ? minLikes : null;
  cfg.likes = menosLikes ? "likes.json" : "";
  cfg.likesSha256 = likesSha256;
  cfg.fechaSorteo = o.fecha;
  cfg.ronda = ronda;
  cfg.prueba = prueba;
  if (o.reel) cfg.reel = o.reel;
  if (o.media) cfg.mediaId = o.media;
  if (!Array.isArray(cfg.requisitos)) cfg.requisitos = [];
  if (!cfg.reemplazos) cfg.reemplazos = "Si un ganador no cumple los requisitos, pasa al siguiente suplente en orden y se publica el motivo.";
  if (!cfg.anuncio) cfg.anuncio = "";
  if (!cfg.archivo) cfg.archivo = { participantes: "", sorteo: "" };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");

  console.log((prueba ? "*** PRUEBA LOCAL (--forzar): NO PUBLICAR ESTA CONFIGURACIÓN ***\n" : "") +
    "Comentarios leídos:        " + totalComentarios.toLocaleString("es-AR"));
  console.log("Usuarios únicos:           " + todos.length.toLocaleString("es-AR"));
  console.log("  con al menos 1 @mención: " + conMencion.toLocaleString("es-AR") + (requiereMencion ? "  (criterio activo)" : ""));
  console.log("  excluidos a mano:        " + [...excluidos].filter(u => porUsuario.has(u)).length + (excluidos.size ? "  (" + [...excluidos].join(", ") + ")" : ""));
  if (menosLikes) {
    const dist = new Map();
    for (const c of todosComentarios) if (elegible(c.u)) dist.set(c.likes, (dist.get(c.likes) || 0) + 1);
    const escala = [...dist.entries()].sort((a, b) => a[0] - b[0]).slice(0, 6);
    console.log("CRITERIO: menos likes      mínimo del reel = " + minLikes + " like" + (minLikes === 1 ? "" : "s"));
    console.log("  comentarios candidatos:  " + candidatos.length.toLocaleString("es-AR") + " de " + totalComentarios.toLocaleString("es-AR"));
    console.log("  reparto de likes:        " + escala.map(([k, v]) => k + " → " + v.toLocaleString("es-AR")).join(" · ") + (dist.size > escala.length ? " · …" : ""));
    console.log("  likes.json:              " + likesSha256.slice(0, 12) + "…  (" + (fs.statSync(likesPath).size / 1048576).toFixed(2) + " MB)");
    console.log("  más likes (premio 2):    mas-likes.txt  — NO se publica, es para elegir a mano");
  }
  console.log("PARTICIPANTES:             " + personas.toLocaleString("es-AR") + (porComentario ? " personas, " + usuarios.length.toLocaleString("es-AR") + " boletos (uno por comentario)" : ""));
  console.log("Respuestas dentro de un hilo: " + (conRespuestas ? "CUENTAN (--con-respuestas)" : descartadasRespuestas.toLocaleString("es-AR") + " descartadas (no cuentan)"));
  if (corteLimite !== null) console.log("CORTE ANUNCIADO:           " + fmt(new Date(corteLimite)) + " hs  (descarté " + descartadosPorCorte.toLocaleString("es-AR") + " comentarios posteriores)");
  console.log("Último comentario contado: " + (corte ? fmt(new Date(corte)) + " hs" : "—"));
  console.log("HUELLA del padrón:         " + sha256);
  console.log("  corta, para el anuncio:  " + sha256.slice(0, 6) + " … " + sha256.slice(-6));
  console.log("Sorteo:                    " + fmt(new Date(o.fecha)) + " hs (Argentina)");
  console.log("Ronda drand " + cfg.cadena + ":     #" + ronda + "  -> sale a las " + fmt(fechaRonda) + " hs" + (prueba && faltanMs < 0 ? "  (YA SALIÓ: solo sirve para probar)" : ""));
  console.log("URL de la ronda:           " + Core.urlRonda(ronda, cadena));
  console.log("\nEscribí: participantes.json, evidencia.json y sorteo.json en " + dir);
  if (!prueba) {
    console.log("\nSIGUIENTE (en este orden, todo ANTES de la hora del sorteo):");
    console.log("  1. git add participantes.json evidencia.json " + (menosLikes ? "likes.json " : "") + "sorteo.json && git commit -m \"Padrón del sorteo\" && git push");
    console.log("  2. Esperar el deploy de Pages y abrir verificar.html: tiene que decir 'coincide' y mostrar la fecha de publicación en GitHub.");
    console.log("  3. node anclar.js --wayback            (copia con fecha en Internet Archive)");
    console.log("  4. Publicar en Instagram (posteo o comentario fijado, no historia): link a verificar.html, participantes, ronda #" + ronda + " y la huella corta.");
    console.log("  5. node anclar.js --anuncio <URL del posteo>   y volver a commitear/pushear sorteo.json.");
  }
})().catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
