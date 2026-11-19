# hyperClouds

Web app personale: orizzonte reale, posizione del Sole e nubi lungo il raggio di alba e tramonto.
File statici, nessun server: funziona su GitHub Pages o su qualsiasi hosting https.

## Pubblicazione su GitHub Pages
1. Su https://github.com crea un account (se non l'hai) e accedi.
2. In alto a destra: **+** → **New repository**. Nome: `hyperclouds`. Visibilità: **Public** (Pages gratuito richiede repository pubblico). **Create repository**.
3. Nella pagina del repository: **uploading an existing file** (oppure **Add file** → **Upload files**). Trascina tutto il contenuto della cartella (index.html, manifest.webmanifest, sw.js, icone, cartella js; la cartella tests è facoltativa). **Commit changes**.
4. **Settings** (scheda in alto nel repository) → menu a sinistra **Pages** → *Build and deployment* → *Source*: **Deploy from a branch** → *Branch*: **main**, cartella **/ (root)** → **Save**.
5. Dopo 1–2 minuti l'indirizzo compare in cima alla stessa pagina: `https://<tuo-utente>.github.io/hyperclouds/`.
6. Sul telefono Android apri l'indirizzo in Chrome → menu **⋮** → **Aggiungi a schermata Home** (o **Installa app**). Su iPhone: Safari → **Condividi** → **Aggiungi alla schermata Home**.

## Test numerici
```
cd tests && npm install && node test.mjs
```
Confronta le effemeridi con astronomy-engine (VSOP87), il DEM con le quote di vette note, la geometria con formule chiuse.

## Fonti dei dati
- Terreno: AWS Terrain Tiles (Terrarium), globale.
- Nubi: Open-Meteo (previsione e archivio delle previsioni). Uso non commerciale gratuito.
- Mappa: OpenFreeMap / OpenStreetMap.
