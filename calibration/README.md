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
