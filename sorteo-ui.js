/* Lógica de pantalla compartida por sortear.html y verificar.html. El algoritmo está en sorteo-core.js. */
(function () {
  "use strict";
  const Core = window.SorteoCore;
  const $ = id => document.getElementById(id);
  const TZ = "America/Argentina/Buenos_Aires";
  const fmtN = n => Number(n).toLocaleString("es-AR");
  const fmtFecha = (d, conSeg) => {
    d = d instanceof Date ? d : new Date(d);
    if (isNaN(d)) return "—";
    return new Intl.DateTimeFormat("es-AR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: conSeg ? "2-digit" : undefined, hour12: false }).format(d);
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hashCorto = h => h ? h.slice(0, 6) + " … " + h.slice(-6) : "—";
  const cuanto = ms => { const h = Math.abs(ms) / 3600e3; return h >= 48 ? Math.round(h / 24) + " días" : h >= 1 ? (Math.round(h * 10) / 10) + " h" : Math.round(Math.abs(ms) / 60e3) + " min"; };
  const urlSegura = u => /^https:\/\//i.test(String(u || "")) ? String(u) : "";

  async function cargarJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("No pude cargar " + url + " (HTTP " + r.status + ")");
    return r.json();
  }
  function banner(id, html, mostrar) { const b = $(id); if (!b) return; if (!mostrar) { b.classList.add("hidden"); return; } b.innerHTML = html; b.classList.remove("hidden"); }
  function error(msg) { const b = $("bannerError"); if (!b) return; b.innerHTML += (b.innerHTML ? "<br>" : "") + esc(msg); b.classList.remove("hidden"); }

  // Carga sorteo.json + participantes.json y hace TODOS los chequeos. Devuelve el estado.
  async function cargar() {
    const st = { bloqueos: [], avisos: [], semillaManual: null, evidencia: null };
    st.cfg = await cargarJSON("sorteo.json");
    const cfg = st.cfg;
    st.cadena = Core.CADENAS[cfg.cadena || "quicknet"];
    if (!st.cadena) throw new Error("sorteo.json: cadena de drand desconocida (" + cfg.cadena + ").");
    st.prueba = !!cfg.prueba;
    st.hashCfg = String(cfg.participantesSha256 || "").toLowerCase();
    // URL versionada con la huella: la CDN de GitHub Pages nunca mezcla un sorteo.json nuevo con una lista vieja.
    st.padron = await cargarJSON((cfg.participantes || "participantes.json") + (st.hashCfg ? "?v=" + st.hashCfg.slice(0, 8) : ""));
    const crudos = Array.isArray(st.padron.usuarios) ? st.padron.usuarios : [];
    // La huella se calcula sobre la lista TAL CUAL está en el archivo (igual que jq | sha256sum).
    st.hashCalc = await Core.hashLista(crudos);
    try { Core.validarLista(crudos); } catch (e) { st.bloqueos.push("La lista publicada no es válida (" + e.message + ")."); }
    // usuarios = boletos tal cual están publicados (con "#n" si cada comentario es una chance);
    // personas = cada usuario una vez, que es lo que se busca, se cuenta y se muestra.
    st.usuarios = crudos;
    st.chances = new Map();
    for (const b of crudos) { const u = Core.usuarioDe(b); st.chances.set(u, (st.chances.get(u) || 0) + 1); }
    st.personas = [...st.chances.keys()];
    st.setUsuarios = new Set(st.personas);
    st.hashOk = st.hashCalc === st.hashCfg && st.hashCalc === String(st.padron.sha256 || "").toLowerCase();
    if (!st.hashOk) st.bloqueos.push("La lista no coincide con la huella de sorteo.json (calculada " + st.hashCalc + ", publicada " + (st.hashCfg || "—") + ").");
    const scCfg = Core.shortcodeDeReel(cfg.reel), scPad = Core.shortcodeDeReel(st.padron.reel);
    if (scCfg && scPad && scCfg !== scPad) st.bloqueos.push("La lista es de otro reel (" + scPad + ") y no del configurado (" + scCfg + ").");
    // La ronda sale SOLO de la fecha anunciada; sorteo.json tiene que decir lo mismo.
    if (!cfg.fechaSorteo) throw new Error("sorteo.json no tiene fechaSorteo. Corré preparar.js con --fecha.");
    st.ronda = Core.rondaParaFecha(cfg.fechaSorteo, st.cadena);
    if (Number(cfg.ronda) !== st.ronda) st.bloqueos.push("sorteo.json es inconsistente: dice ronda #" + cfg.ronda + " pero la fecha anunciada corresponde a la #" + st.ronda + ". Corré preparar.js de nuevo.");
    if (!Core.esMinutoEnPunto(cfg.fechaSorteo)) st.bloqueos.push("La hora del sorteo no está en minuto en punto (" + cfg.fechaSorteo + ").");
    st.fechaRonda = Core.fechaDeRonda(st.ronda, st.cadena);
    st.generado = st.padron.generado && !isNaN(Date.parse(st.padron.generado)) ? new Date(st.padron.generado) : null;
    if (st.generado && st.generado.getTime() >= st.fechaRonda.getTime()) {
      const msg = "La lista se generó DESPUÉS de que la ronda fuera pública (" + fmtFecha(st.generado, true) + " hs): así el sorteo no vale, la ronda tiene que ser posterior a la lista.";
      (st.prueba ? st.avisos : st.bloqueos).push(msg);
    }
    const p = new URLSearchParams(location.search);
    if (p.get("semilla")) { const s = p.get("semilla").trim().toLowerCase(); if (Core.esHex64(s)) st.semillaManual = s; else st.avisos.push("La semilla de la dirección no es válida (64 caracteres hexadecimales)."); }
    st.codigoParam = (p.get("codigo") || "").trim();
    st.corte = st.padron.corte && !isNaN(Date.parse(st.padron.corte)) ? new Date(st.padron.corte) : null;
    return st;
  }

  function renderCabecera(st) {
    const cfg = st.cfg;
    if ($("titulo")) $("titulo").textContent = cfg.titulo || "Sorteo";
    if ($("premio")) $("premio").textContent = cfg.premio || "";
    if ($("org")) $("org").textContent = cfg.organizador || "";
    const reel = $("reel"); if (reel) { if (urlSegura(cfg.reel)) reel.href = cfg.reel; else reel.classList.add("hidden"); }
    if (cfg.fondo) document.documentElement.style.setProperty("--fondo", "url(" + JSON.stringify(String(cfg.fondo)) + ")");
    // Colores del sorteo (sorteo.json → tema): solo hex, para que un valor raro no rompa el CSS.
    const hex = v => /^#[0-9a-f]{6}$/i.test(String(v || "")) ? v : "";
    const tema = cfg.tema || {};
    if (hex(tema.acento)) document.documentElement.style.setProperty("--accent", tema.acento);
    if (hex(tema.acento2)) document.documentElement.style.setProperty("--accent2", tema.acento2);
    banner("bannerPrueba", "<b>PRUEBA LOCAL.</b> Esta configuración se armó con <code>--forzar</code>: sirve para probar la herramienta, no para un sorteo real.", st.prueba);
    if (st.bloqueos.length) banner("bannerError", st.bloqueos.map(esc).join("<br>"), true);
    if (st.avisos.length) banner("bannerAviso", st.avisos.map(esc).join("<br>"), true);
    if (st.semillaManual) banner("bannerManual", "<b>Reproducción manual.</b> Esta corrida usa la semilla pegada en la dirección, no consulta drand. Verificá que sea la <code>randomness</code> de la ronda #" + st.ronda + ".", true);
    const repo = urlSegura(String(cfg.repo || "").replace(/\/$/, ""));
    if ($("pie")) $("pie").innerHTML = "Sorteo verificable · azar público de <a class='link' href='https://drand.love' target='_blank' rel='noopener'>drand</a>" + (repo ? " · <a class='link' href='" + esc(repo) + "' target='_blank' rel='noopener'>código abierto</a>" : "");
    return repo;
  }

  function renderPadron(st) {
    const cfg = st.cfg, padron = st.padron;
    if ($("kParticipantes")) $("kParticipantes").textContent = fmtN(st.personas.length);
    if ($("kComentarios")) $("kComentarios").textContent = padron.comentarios ? fmtN(padron.comentarios) : "—";
    if ($("kCorte")) $("kCorte").textContent = st.corte ? fmtFecha(st.corte) + " hs" : "—";
    const crit = padron.criterio || {};
    let critTxt = crit.descripcion || "Una entrada por usuario.";
    if (crit.excluidos && crit.excluidos.length) critTxt += " No participan: " + crit.excluidos.map(u => "@" + u).join(", ") + ".";
    if ($("criterio")) $("criterio").textContent = critTxt;
    // Criterio "menos likes": la explicación general no alcanza, hay que decir por qué quedó afuera la mayoría.
    if (crit.menosLikes) {
      const nL = Number(crit.minLikes) || 0;
      const conLikes = " like" + (nL === 1 ? "" : "s");
      if ($("comoLista")) $("comoLista").innerHTML = "<b>La lista.</b> Se bajan <b>todos</b> los comentarios del reel con la API oficial de Instagram hasta la fecha de corte y se anota cuántos likes tenía cada uno (está publicado en <a class='link' href='" + esc(cfg.likes || "likes.json") + "' target='_blank' rel='noopener'>likes.json</a>). Como el premio es para el comentario con <b>menos likes</b>, entran solo los que tenían el mínimo del reel: <b>" + nL + conLikes + "</b>" + (crit.comentariosCandidatos ? " (" + fmtN(crit.comentariosCandidatos) + " comentarios)" : "") + ". Cada persona entra <b>una sola vez</b>, aunque tenga varios de esos comentarios. La lista se publica antes del sorteo con su huella (SHA-256) y esa huella se anuncia en Instagram.";
      if ($("vLikesTxt")) { $("vLikesTxt").classList.remove("hidden"); if ($("vLikes") && cfg.likes) $("vLikes").href = cfg.likes; }
    }
    if (crit.porComentario) {
      if ($("comoLista")) $("comoLista").innerHTML = "<b>La lista.</b> Se bajan <b>todos</b> los comentarios del reel con la API oficial de Instagram hasta el cierre. <b>Cada comentario es un boleto</b>: <code>usuario#1</code> es el primer comentario de esa persona, <code>usuario#2</code> el segundo, y así (el id de cada uno está en <a class='link' href='" + esc(cfg.evidencia || "evidencia.json") + "' target='_blank' rel='noopener'>evidencia.json</a>). Quien comentó más tiene más chances, pero <b>nadie puede ganar dos veces</b>. La lista se publica antes del sorteo con su huella (SHA-256).";
      if ($("comoOrden")) $("comoOrden").innerHTML = "<b>El orden.</b> Con ese número como semilla, a cada boleto se le calcula un puntaje (SHA-256 de <code>semilla:boleto</code>) y se ordenan de menor a mayor. Se recorre ese orden y cada persona aparece una sola vez, en su mejor boleto: si ya salió, sus otros boletos se saltean. Los primeros son los ganadores; los que siguen, los suplentes.";
    }
    if ($("cantidades")) $("cantidades").textContent = fmtN(cfg.ganadores || 0) + " ganadores + " + fmtN(cfg.suplentes || 0) + " suplentes";
    const req = $("requisitos");
    if (req) {
      const lista = Array.isArray(cfg.requisitos) ? cfg.requisitos.filter(Boolean) : [];
      if (lista.length || cfg.reemplazos) {
        req.innerHTML = (lista.length ? "<b>Requisitos:</b> " + lista.map(esc).join(" · ") + ". " : "") + (cfg.reemplazos ? "<b>Reemplazos:</b> " + esc(cfg.reemplazos) : "");
        req.classList.remove("hidden");
      } else req.classList.add("hidden");
    }
    const chk = $("chkHash");
    if (chk) {
      const anuncio = urlSegura(cfg.anuncio);
      chk.innerHTML = (st.hashOk
        ? '<span class="ok">✓ La lista coincide con la huella de sorteo.json</span>'
        : '<span class="err">✗ La lista NO coincide con la huella de sorteo.json</span>') +
        ' · Huella <b class="hcorto">' + esc(hashCorto(st.hashCalc)) + '</b> <button type="button" class="mini" id="verHash">ver completa</button>' +
        '<code id="hashFull" class="hidden">' + esc(st.hashCalc) + "</code>" +
        '<div class="muted" style="margin-top:6px">Tiene que ser la misma huella que se publicó en Instagram antes del sorteo' + (anuncio ? ' (<a class="link" href="' + esc(anuncio) + '" target="_blank" rel="noopener">ver anuncio</a>)' : "") + ". El historial de git no sirve como prueba de fecha; las fechas de abajo sí.</div>" +
        (st.generado ? '<div class="muted">Lista generada el ' + fmtFecha(st.generado, true) + " hs" + (st.generado < st.fechaRonda ? ", " + cuanto(st.fechaRonda - st.generado) + " antes de la ronda" : ' <span class="err">— después de la ronda</span>') + "</div>" : "");
      $("verHash").onclick = () => { $("hashFull").classList.toggle("hidden"); $("verHash").textContent = $("hashFull").classList.contains("hidden") ? "ver completa" : "ocultar"; };
    }
  }

  // Tablero de números: lo que hace que el sorteo se lea transparente antes de que alguien pregunte.
  function renderTablero(st) {
    const el = $("tablero"); if (!el) return;
    const r = (st.padron || {}).resumen;
    if (!r) { el.classList.add("hidden"); return; }
    const crit = st.padron.criterio || {};
    const nL = Number(r.minLikes) || 0;
    const plural = n => n === 1 ? "" : "s";
    const datos = [];
    datos.push(["comentarios leídos", fmtN(r.comentarios), ""]);
    datos.push(["personas que comentaron", fmtN(r.personasQueComentaron), ""]);
    if (crit.porComentario) datos.push(["comentarios que participan (una chance cada uno)", fmtN(st.usuarios.length), ""]);
    if (crit.menosLikes) {
      datos.push([
        "comentarios con " + nL + " like" + plural(nL) + (nL === 0 ? "" : ", el mínimo"),
        fmtN(r.enElMinimo), "destaca"
      ]);
    }
    datos.push(["personas en el sorteo", fmtN(r.participantes), "destaca"]);
    // Los likes solo se muestran cuando deciden algo (criterio "menos likes"); en un sorteo al azar distraen.
    if (crit.menosLikes && r.masLikes) {
      const url = Core.urlComentario(st.cfg.reel, r.masLikes.id);
      const quien = "@" + esc(r.masLikes.usuario);
      datos.push([
        "el más likeado, con " + fmtN(r.masLikes.likes),
        url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + quien + "</a>" : quien,
        "chica"
      ]);
    }
    datos.push(["comentarios contados hasta el", st.corte ? fmtFecha(st.corte) + " hs" : "—", "chica"]);

    el.innerHTML = datos.map(([rot, val, mod]) =>
      '<div class="dato' + (mod === "destaca" ? " destaca" : "") + '"><b' + (mod === "chica" ? ' class="chica"' : "") + ">" +
      val + "</b><span>" + esc(rot) + "</span></div>").join("");
    el.classList.remove("hidden");

    // Reparto de likes: se ve de un vistazo por qué ganó el que ganó.
    const rep = $("reparto");
    if (rep && crit.menosLikes && Array.isArray(r.reparto) && r.reparto.length > 1) {
      const max = r.reparto.reduce((m, [, n]) => Math.max(m, n), 0) || 1;
      rep.innerHTML = '<div class="tit">Cuántos likes tenía cada comentario al cierre</div><ol>' +
        r.reparto.map(([k, n]) =>
          '<li' + (crit.menosLikes && k === nL ? ' class="gana"' : "") + '>' +
          '<span class="lk">' + fmtN(k) + " like" + plural(k) + "</span>" +
          '<span class="barra"><i style="width:' + Math.max(2, Math.round(n / max * 100)) + '%"></i></span>' +
          '<span class="cant">' + fmtN(n) + "</span></li>").join("") + "</ol>";
      rep.classList.remove("hidden");
    }
  }

  // Anclas externas: fechas que NO pone el organizador.
  async function renderAnclas(st) {
    const el = $("anclas"); if (!el) return;
    const cfg = st.cfg, filas = [];
    const veredicto = (fecha) => fecha < st.fechaRonda
      ? '<span class="ok">✓ ' + cuanto(st.fechaRonda - fecha) + " antes de la ronda</span>"
      : '<span class="err">✗ DESPUÉS de la ronda</span>';
    el.innerHTML = '<div class="muted">Consultando GitHub…</div>';
    try {
      const a = await Core.anclaGitHub(cfg.repo, st.hashCfg, st.ronda);
      if (!a) filas.push('<li><b>GitHub Pages:</b> <span class="muted">sin repositorio configurado</span></li>');
      else if (a.primero) filas.push('<li><b>Publicada en GitHub Pages</b> el ' + fmtFecha(a.primero.creado, true) + " hs — " + veredicto(a.primero.creado) + ' <span class="muted">(fecha puesta por GitHub, no por el organizador · <a class="link" href="' + esc(a.primero.url) + '" target="_blank" rel="noopener">commit</a> · <a class="link" href="' + esc(a.urlDeploys) + '" target="_blank" rel="noopener">deploys</a>)</span></li>');
      else filas.push('<li><b>GitHub Pages:</b> <span class="warn">no encontré ninguna publicación con esta lista y esta ronda</span> <span class="muted">(revisé ' + a.deploys + ' deploys: ¿todavía no se subió, o se cambió después?)</span></li>');
    } catch (e) { filas.push('<li><b>GitHub Pages:</b> <span class="muted">no se pudo consultar (' + esc(e.message) + ")</span></li>"); }
    const arch = cfg.archivo || {};
    const capturas = [["participantes", "lista"], ["sorteo", "configuración"]];
    let alguna = false;
    for (const [k, nombre] of capturas) {
      const u = urlSegura(arch[k]); if (!u) continue; alguna = true;
      const f = Core.fechaWayback(u);
      filas.push('<li><b>Copia en Internet Archive</b> de la ' + nombre + (f ? " el " + fmtFecha(f, true) + " hs — " + veredicto(f) : ' <span class="warn">(fecha ilegible)</span>') + ' <span class="muted">(<a class="link" href="' + esc(u) + '" target="_blank" rel="noopener">ver captura</a>)</span></li>');
    }
    if (!alguna) filas.push('<li><b>Internet Archive:</b> <span class="muted">sin captura registrada</span></li>');
    const anuncio = urlSegura(cfg.anuncio);
    filas.push(anuncio ? '<li><b>Anuncio en Instagram</b> con la huella y la ronda: <a class="link" href="' + esc(anuncio) + '" target="_blank" rel="noopener">ver</a> <span class="muted">(compará la huella y el número de ronda con los de esta página; la fecha la pone Instagram)</span></li>'
      : '<li><b>Anuncio en Instagram:</b> <span class="muted">sin link registrado</span></li>');
    el.innerHTML = "<ul class='anclas'>" + filas.join("") + "</ul>";
  }

  function buscador(st, getPosiciones) {
    const inp = $("buscar"), out = $("buscarRes"); if (!inp || !out) return () => {};
    const crit = st.padron.criterio || {};
    const excluidos = new Set(crit.excluidos || []);
    const porQueNo = crit.menosLikes
      ? "— entran solo los comentarios con " + (Number(crit.minLikes) || 0) + " like" + ((Number(crit.minLikes) || 0) === 1 ? "" : "s") + ", que era el mínimo del reel al cierre: si tu comentario tenía más, quedó afuera. Mirá likes.json para ver los tuyos. Además cuentan solo los comentarios hasta el "
      : "— solo cuentan los comentarios hasta el ";
    const fn = () => {
      const u = Core.normalizarUsuario(inp.value);
      if (!u) { out.textContent = ""; return; }
      if (excluidos.has(u)) { out.innerHTML = '<span class="warn">@' + esc(u) + " está excluido del sorteo</span>"; return; }
      if (!st.setUsuarios.has(u)) { out.innerHTML = '<span class="err">✗ @' + esc(u) + ' no está en la lista</span> <span class="muted">' + porQueNo + (st.corte ? fmtFecha(st.corte) + " hs" : "corte") + ", y el usuario tiene que estar escrito igual que en Instagram</span>"; return; }
      const evs = st.evidencia && st.evidencia.comentarios;
      const ev = evs && (evs[u] || evs[u + "#1"]);
      const cuando = ev && ev.ts ? ' <span class="muted">(comentó el ' + fmtFecha(ev.ts) + " hs)</span>" : "";
      const posiciones = getPosiciones();
      const n = st.chances.get(u) || 1;
      const chances = crit.porComentario ? ' <span class="muted">con ' + n + (n === 1 ? " comentario: 1 chance" : " comentarios: " + n + " chances") + "</span>" : "";
      if (!posiciones) { out.innerHTML = '<span class="ok">✓ @' + esc(u) + " está en la lista</span>" + chances + cuando; return; }
      const pos = posiciones.get(u), nG = Number(st.cfg.ganadores) || 0, nS = Number(st.cfg.suplentes) || 0;
      let rol = "";
      if (pos < nG) rol = ' <span class="ok">— ¡GANADOR!</span>';
      else if (pos < nG + nS) rol = ' <span class="warn">— suplente ' + (pos - nG + 1) + "</span>";
      out.innerHTML = '<span class="ok">✓ @' + esc(u) + "</span> quedó en el puesto " + fmtN(pos + 1) + " de " + fmtN(st.personas.length) + rol + chances;
    };
    inp.addEventListener("input", fn);
    return fn;
  }

  function textoCountdown(st) {
    const faltan = st.fechaRonda.getTime() - Date.now();
    if (faltan <= 0) return "";
    const s = Math.floor(faltan / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), seg = s % 60;
    const pad = n => String(n).padStart(2, "0");
    return "Faltan " + (d ? d + (d === 1 ? " día " : " días ") : "") + pad(h) + ":" + pad(m) + ":" + pad(seg);
  }

  function mensajeDrand(e, ronda) {
    const motivo = e.motivo || (e.detalles ? Core.clasificarFallas(e.detalles) : "");
    if (motivo === "no-publicada") return "drand todavía no publicó la ronda #" + ronda + ". Si el reloj de tu dispositivo va adelantado, esperá a la hora anunciada y probá de nuevo.";
    if (motivo === "sin-conexion") return "No hay conexión con drand. Revisá la red y probá de nuevo: la ronda #" + ronda + " ya está fijada, no la elige nadie y no cambia.";
    const det = (e.detalles || []).filter(d => d.error).map(d => d.espejo.replace("https://", "") + ": " + d.error).join("; ");
    return "No pude leer la ronda #" + ronda + " (" + e.message + (det ? " — " + det : "") + "). La ronda no cambia: el resultado va a ser el mismo cuando se pueda leer.";
  }

  // Devuelve la semilla: manual (?semilla=) o consultando drand con reintentos mientras la ronda no esté publicada.
  async function obtenerSemilla(st, onEstado, limiteMs) {
    if (st.semillaManual) return { ronda: st.ronda, randomness: st.semillaManual, fuentes: [], fallas: [], firmaCoincide: null, manual: true };
    const limite = Date.now() + (limiteMs || 60000);
    for (;;) {
      onEstado("Consultando la ronda #" + st.ronda + " en drand…");
      try { return await Core.obtenerRonda(st.ronda, { cadena: st.cadena }); }
      catch (e) {
        if (e.sinRespuesta && e.motivo !== "sin-conexion" && Date.now() < limite) { onEstado("La ronda todavía no está publicada, reintento…"); await sleep(2000); continue; }
        e.amigable = mensajeDrand(e, st.ronda); throw e;
      }
    }
  }

  function htmlFuentes(info) {
    if (info.manual) return '<span class="warn">semilla ingresada a mano — no consultada a drand</span>';
    const n = info.fuentes.length, total = Core.ESPEJOS.length;
    const clase = n >= 3 ? "ok" : "warn";
    let s = '<span class="' + clase + '">' + n + " de " + total + " fuentes de drand devolvieron la misma semilla</span>";
    if (info.fallas && info.fallas.length) s += ' <span class="muted">(fallaron: ' + info.fallas.map(f => esc(f.espejo.replace("https://", "")) + " " + esc(f.error)).join(", ") + "; la semilla igual se puede cotejar después en cualquier espejo)</span>";
    if (info.firmaCoincide === true) s += ' · <span class="muted">consistencia randomness = SHA-256(firma) (no verifica la firma BLS)</span>';
    else if (info.firmaCoincide === false) s += ' · <span class="err">la firma no coincide con la randomness</span>';
    return s;
  }

  // Evidencia por usuario (id y fecha del primer comentario). Se carga aparte porque es pesada.
  async function cargarEvidencia(st) {
    const cfg = st.cfg;
    if (!cfg.evidencia) return null;
    try {
      const h8 = String(cfg.evidenciaSha256 || "").slice(0, 8);
      const ev = await cargarJSON(cfg.evidencia + (h8 ? "?v=" + h8 : ""));
      const calc = await Core.hashEvidencia(st.usuarios, ev.comentarios || {});
      ev.ok = calc === String(cfg.evidenciaSha256 || "").toLowerCase();
      st.evidencia = ev;
      return ev;
    } catch (e) { st.evidencia = { ok: false, error: e.message, comentarios: {} }; return st.evidencia; }
  }
  // Con boleto, el link va al comentario que salió sorteado; sin boleto, al primero de esa persona.
  function linkComentario(st, usuario, boleto) {
    const evs = st.evidencia && st.evidencia.comentarios;
    const ev = evs && ((boleto && evs[boleto]) || evs[usuario] || evs[usuario + "#1"]);
    return ev && ev.id ? Core.urlComentario(st.cfg.reel, ev.id) : "";
  }

  function copiar(txt, btn, fallbackEl) {
    const listo = () => { const t = btn.textContent; btn.textContent = "Copiado"; setTimeout(() => btn.textContent = t, 1600); };
    const manual = () => {
      if (fallbackEl) { const r = document.createRange(); r.selectNodeContents(fallbackEl); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      btn.textContent = "Seleccioná y copiá";
    };
    if (!navigator.clipboard) return manual();
    navigator.clipboard.writeText(txt).then(listo, manual);
  }

  window.SorteoUI = { $, fmtN, fmtFecha, esc, sleep, hashCorto, cuanto, cargar, error, banner, renderCabecera, renderPadron, renderTablero, renderAnclas, buscador, textoCountdown, obtenerSemilla, htmlFuentes, mensajeDrand, cargarEvidencia, linkComentario, copiar, urlSegura };
})();
