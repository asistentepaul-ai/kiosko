# Kiosko

Hemeroteca personal: cada mañana a las 6:00 descarga las noticias principales de siete
diarios españoles, las convierte en PDF limpio (sin publicidad, sin recomendaciones,
sin muros) y publica la portada del día en una web estática.

## Cómo funciona

```
portada del diario  ->  Chrome headless (CDP)  ->  extracción del cuerpo
                    ->  limpieza (anuncios, recomendados, newsletter)
                    ->  imágenes incrustadas en base64
                    ->  PDF A4  ->  web estática
```

- `build.js` — orquesta la descarga completa del día.
- `lib/cdp.js` — cliente mínimo del protocolo DevTools (WebSocket nativo, sin dependencias).
- `lib/front.js` — elige las noticias de la portada en el orden en que aparecen.
- `lib/extract.js` — aísla el cuerpo del artículo y descarta el ruido.
- `lib/render.js` — maqueta del PDF.
- `lib/images.js` — descarga y recompresión de imágenes.
- `server.js` — servidor local que recibe la orden de actualización desde la web.
- `assets/` y `index.html` — la web.

## Uso

```bash
node build.js                      # baja todo, poda el archivo y publica
node build.js --papers=elpais --limit=5 --no-push
node build.js --date=2026-10-28    # reconstruye una fecha concreta
node server.js                     # API local para el botón «Actualizar»
```

## Archivo

`data/AAA-MM-DD/<diario>/` guarda los PDFs, las miniaturas y el índice del día.
Al entrar el día 11, la carpeta más antigua se borra sola (`KEEP_DAYS` en `build.js`).

## Servicios

- `ai.openclaw.kiosko-build` — descarga a las 6:00 (launchd, se recupera al despertar).
- `ai.openclaw.kiosko-server` — API en `127.0.0.1:4780`, publicada por Tailscale Funnel
  en `https://mac-mini-de-paul.tail790c0b.ts.net/kiosko`.

El botón «Actualizar» de la web hace `POST /refresh` contra ese endpoint; el Mac lanza
el build y la web se refresca sola cuando termina.

## Límites

- Retención de 10 días.
- Presupuesto de espacio: ~30-40 MB de PDFs al día.
- El recorte es para lectura personal y no se redistribuye.
