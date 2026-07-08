# Sorteo IG · Descargar comentarios

Herramienta para bajar **todos los comentarios de un reel/posteo de Instagram** (cuenta Business/Creator) con la cantidad de likes de cada uno, y exportarlos a un **CSV** (usuario, likes, texto, fecha) para filtrar un sorteo.

## 🌐 Usar online (sin instalar nada)

**→ https://xdapx.github.io/sorteo-ig-comentarios/**

Pegás el Access Token y el link del reel, y baja todo. El token **va directo del navegador a Meta**: no se guarda ni se comparte en ningún lado.

## Qué necesitás

Un **Access Token** de la cuenta (lo genera el admin una sola vez, es todo clicks). Ver [`instrucciones_sorteo_ig.md`](instrucciones_sorteo_ig.md), Pasos 0 a 2. El token tiene que tener estos permisos:

- `instagram_basic`
- `instagram_manage_comments`
- `pages_show_list`
- `pages_read_engagement`

La web resuelve sola el Page ID, el IG User ID y el Media ID (Pasos 3 a 5 del instructivo): solo pegás el **link del reel**.

## Notas

- Funciona 100% en el navegador (llama a la API de Meta directo). Para volúmenes grandes (decenas/cientos de miles de comentarios), dejá la pestaña abierta: guarda el progreso y **retoma solo** si se corta o si Instagram pide esperar por límite de uso.
- El CSV se arma con datos de la propia cuenta. Manejá el archivo con cuidado: contiene nombres de usuario.

## Alternativa por línea de comandos

[`sorteo_ig.py`](sorteo_ig.py) hace lo mismo desde la terminal (`pip install requests` y `python sorteo_ig.py`), más robusto para corridas largas desatendidas porque escribe a disco y retoma solo. Además incluye una opción para elegir un ganador al azar (con semilla registrada) entre los comentarios con menos likes.
