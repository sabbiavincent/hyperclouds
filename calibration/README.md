# Taratura della probabilità "disco visibile"

**Verità al suolo:** soleggiamento misurato ogni 10 minuti (DWD, `10_minutes/solar`, campo SD_10; sole se ≥ 5 min su 10).
Stazioni: 03631 Norderney (costa, orizzonte di mare), 03015 Lindenberg (pianura). Periodo 2025-06-01 – 2026-05-31, solo sera.

**Previsioni:** Open-Meteo Historical Forecast API, modello `icon_d2` (scadenze 0–3 h), nubi basse/medie/alte su un ventaglio
di 9 azimut (195°–315°, passo 15°) × 10 distanze (5–220 km); interpolazione in azimut, distanza e tempo; raggio con
curvatura e rifrazione (k = 0,13), passo 2 km fino a 13 km di quota.

**Procedura:** `rows.mjs` (Node) costruisce gli intervalli dai file DWD; `browser_feat.js` gira nel browser
(le chiamate Open-Meteo partono dal browser) e calcola per ogni intervallo copertura massima e S = Σ ln(1−c)·Δd;
`analyze.py` unisce e valuta.

## Risultati (Sole tra 4° e 10°, 3593 intervalli)
| copertura massima lungo il raggio | sole osservato |
|---|---|
| 0–10% | 98% |
| 30–40% | 82% |
| 50–60% | 70% |
| 70–80% | 45% |
| 80–90% | 30% |
| > 90% | 7% |

- Modello P = exp(S/L): L ottimale 50 km; Brier 0,100 contro 0,224 della climatologia (skill 0,55).
  Validazione incrociata tra stazioni: L = 50–60 km, skill 0,49–0,61. Probabilità ben calibrate (deviazioni ≤ 5 punti
  tranne la fascia 70–80%).
- Soglia secca migliore: 85% (PSS 0,69, accuratezza 0,84). La sola nuvolosità sopra la stazione: PSS 0,67, skill 0,48.
- Tra 2° e 4° con previsione serena i sensori registrano sole solo nel 75% dei casi (contro 96–99% sopra 4°):
  limite di misura (soglia WMO 120 W/m² di irradianza diretta). Sotto 4° la regola è estrapolata.

## Limiti
Scadenze brevi (le previsioni a 24–48 h sono meno accurate); due stazioni di pianura nordtedesca, un anno.

## Seconda taratura (20/11/2026): geometria degli strati, 3 stazioni
Aggiunta 01443 Freiburg (rilievi: Vosgi a ovest, orizzonte fino a +2,8°; esclusi 94 intervalli col Sole a meno di 1° sopra
il rilievo). 66 geometrie confrontate: base delle nubi basse 0/300/600/1000/1500/2000 m, cima 2000/3000 m, base delle medie
3000/4000/5000 m, base delle alte 8000/9500 m. Per ciascuna L scelto a Brier minimo; validazione lasciando fuori una stazione.
Script: `browser/cal2.js` (funzioni `run` ed `evaluate`), verità al suolo in `browser/t2_*.json`.

| geometria (basse / medie / alte) | L | skill | skill in validazione (Norderney, Lindenberg, Freiburg) |
|---|---|---|---|
| 0–3000 / 3000–8000 / > 8000 (attuale) | 50 km | 0,479 | 0,456 (0,47 · 0,61 · 0,29) |
| 0–3000 / 3000–8000 / > 9500 (migliore) | 40 km | 0,490 | 0,466 (0,49 · 0,62 · 0,28) |
| base basse sollevata a 1500 m, cima 2000 m (peggiore) | 20–30 km | 0,33 | 0,32 |

- **Ipotesi "conta la base delle nubi" smentita su questi dati:** sollevare la base delle nubi basse peggiora sempre;
  la geometria attuale è entro 0,01 di skill dalla migliore (differenza non significativa). Si mantiene il modello attuale.
  Interpretazione possibile, non verificata: la "copertura bassa" dei modelli include nebbia e strati vicini al suolo, e la
  copertura sopra la stazione è di per sé informativa.
- **Freiburg, con rilievi, ha skill molto più bassa (0,29 contro 0,47–0,62):** in orografia complessa il modello rende meno.
  Per Firenze è ragionevole attendersi un'affidabilità più vicina a Freiburg che alla pianura.

## Terza taratura (20/11/2026): Ticino (MeteoSwiss, soleggiamento a 10 minuti `sre000z0`)
Stazioni: LUG Lugano (273 m, lago tra rilievi; orizzonte fino a +11°, esclusi 877 intervalli), SBO Stabio (351 m, margine
della pianura padana; orizzonte fino a +7°, esclusi 583), CIM Cimetta (1661 m, montagna; esclusi 136). Stesso periodo e metodo.

| stazione | intervalli (Sole ≥ 4°) | sole osservato | skill del modello della app (L = 50 km) |
|---|---|---|---|
| Lugano | 1036 | 41% | 0,47 |
| Cimetta | 1452 | 43% | 0,41 |
| Stabio | 1215 | 26% | −0,12 (peggio della climatologia) |

- Lugano e Cimetta: rendimento simile alla pianura tedesca; nelle fasce intermedie (40–80%) il modello è troppo ottimista
  (osservato 31–52% contro 50–70% previsto).
- **Stabio fallisce:** anche con probabilità prevista 80–100% il sole è registrato solo nel 57% dei casi. Ipotesi, non
  verificata: foschia e inquinamento della pianura padana attenuano il disco sotto la soglia WMO di 120 W/m² di irradianza
  diretta anche a 4–10° di elevazione. Il sensore registra "niente sole" anche quando un disco rosso e attenuato può
  essere visibile e fotografabile. La soglia del sensore non coincide con la visibilità fotografica.
- Sulle tre stazioni ticinesi il valore di L che rende meglio è 15–20 km (contro 40–50 km in pianura); anche qui la geometria
  degli strati conta poco (differenze ≤ 0,001 di skill in validazione).
- Conseguenza per Firenze (conca dell'Arno con inversioni e foschia invernali): attendersi comportamento intermedio tra
  Lugano e Stabio. Il modello resta invariato (L = 50 km) finché non ci sono dati più vicini; la regione con foschia richiede
  un termine di attenuazione da aerosol, non presente.
