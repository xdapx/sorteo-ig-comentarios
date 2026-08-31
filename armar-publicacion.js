#!/usr/bin/env node
/*
  Arma sorteo.html: una sola pagina autocontenida, lista para publicar.
  Mete adentro el CSS, el motor, la miniatura del reel y los datos SIN el texto de los
  comentarios (el link lleva al comentario en Instagram, que es donde ya es publico).
    node armar-publicacion.js
*/
"use strict";
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const leer = f => fs.readFileSync(path.join(dir, f), "utf8");

const app = leer("app.html"), css = leer("sorteo.css"), core = leer("sorteo-core.js");
const d = JSON.parse(leer("datos.json"));

let miniatura = "";
const fMini = path.join(dir, "miniatura.jpg");
if (fs.existsSync(fMini)) miniatura = "data:image/jpeg;base64," + fs.readFileSync(fMini).toString("base64");

const datos = {
  reel: d.reel, publicado: d.publicado, bajado: d.bajado, declarados: d.declarados, miniatura,
  comentarios: d.comentarios.map(c => ({ u: c.u, l: c.l, ts: c.ts, id: c.id, r: c.r }))
};

const estilos = app.split("<style>")[1].split("</style>")[0];
const cuerpo = app.split("<body>")[1].split("<script src=")[0];
let js = app.split('sorteo-core.js"></scr' + "ipt>")[1].split("<script>")[1].split("</scr" + "ipt>")[0];
js = js.replace('DATOS = await (await fetch("datos.json",{cache:"no-store"})).json();', "DATOS = window.__DATOS__;");
if (!js.includes("window.__DATOS__")) throw new Error("no se pudo reemplazar la carga de datos.json");
if (JSON.stringify(datos).includes('"t":')) throw new Error("los datos llevan el texto de los comentarios: NO publicar");

const html = '<!DOCTYPE html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<meta name="robots" content="noindex">\n' +
  "<title>Sorteo del Alpine · @damiancivale</title>\n<style>\n" + css + "\n" + estilos + "\n</style>\n</head>\n<body>\n" +
  cuerpo + "<scr" + "ipt>" + core + "</scr" + "ipt>\n<scr" + "ipt>window.__DATOS__=" + JSON.stringify(datos) + ";</scr" + "ipt>\n" +
  "<scr" + "ipt>" + js + "</scr" + "ipt>\n</body>\n</html>\n";

fs.writeFileSync(path.join(dir, "sorteo.html"), html);
console.log("sorteo.html  " + (html.length / 1024).toFixed(0) + " KB");
console.log("  comentarios:  " + datos.comentarios.length + " (sin el texto)");
console.log("  miniatura:    " + (miniatura ? (miniatura.length / 1024).toFixed(0) + " KB embebida" : "NO"));

// Version para publicar como artifact: ahi la pagina se sirve dentro de un <head>/<body> que
// pone la propia herramienta, asi que va solo el contenido con el title y el style adelante.
// El visor bloquea las descargas que arranca la pagina, asi que el boton de bajar los
// ganadores usa claude.use("downloads"); hay que publicarla con capabilities {downloads:true}.
const artifact = "<title>" + html.split("<title>")[1].split("</title>")[0] + "</title>\n" +
  "<style>\n" + html.split("<style>")[1].split("</style>")[0] + "\n</style>\n" +
  html.split("<body>")[1].split("</body>")[0];
fs.writeFileSync(path.join(dir, "sorteo-artifact.html"), artifact);
console.log("sorteo-artifact.html  " + (artifact.length / 1024).toFixed(0) + " KB (publicar con capabilities {downloads:true})");
