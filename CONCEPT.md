# SoundPointer – Konzept, Umsetzung, Probleme

*Arbeitsdokument zur Weiterentwicklung mit anderen KIs/Entwicklern. Stand: Juni 2026.*
*Repository: `gunterstruck/soundpointer` · Live: https://soundpointer.vercel.app*

---

## 1. Vision & Anwendungsfall

SoundPointer ist eine **PWA** (kamerabasiertes AR-Overlay + Audioauswertung auf dem Smartphone), die dem Benutzer hilft, die **räumliche Herkunft eines bestimmten Störgeräuschs** zu finden.

**Kern-Anwendungsfall:** In einem (oft lauten) **Industrie-/Maschinenumfeld** tritt ein neues, störendes, meist **tonales** Signal auf (z. B. ein Pfeifen bei 2 kHz). Der Benutzer kennt oder misst die Frequenz und möchte mit dem Handy die **Richtung/Quelle** eingrenzen.

**Wichtige Grundhaltung:** SoundPointer ist **kein Präzisions-Messgerät**, sondern ein **interaktiver Such-Assistent**. Es soll die Suche auf **wenige plausible Kandidaten** eingrenzen; die finale Entscheidung trifft der Mensch.

---

## 2. Die drei Betriebsmodi (Architektur-Idee)

Wir halten **drei Denkrichtungen** bewusst getrennt:

| Modus | Name | Prinzip | Status |
|---|---|---|---|
| **A** | Sensorstabile AR-Markierung | Reine Orientierung; Punkt als Raumrichtung auf virtueller Kugel. Plus experimentelles 6DoF (IMU-Position). | Stabil, dient als **Sensor-/Qualitätslabor** |
| **B** | Virtuelles Mikrofon-Array | Ein bewegtes Handy-Mikro erzeugt über die Zeit ein „virtuelles Array"; aus Phasendifferenzen → Richtung. | **Funktioniert nicht zuverlässig** (siehe §6) |
| **C** | Akustische HF-Taschenlampe | Gerichtetes (USB-)Mikro hört NUR 12–20 kHz; Blickrichtung gewichtet → Ableitungs-Ring („Donut") + verblassende Heatmap + Zentrum. | **Aktueller MVP-Fokus** |
| **D** | Virtuelles Array (VIO, frei bewegen) | WebXR/ARCore-Pose + kohärente Phase; Auswahl-Algorithmus übernimmt selbst brauchbare Bewegungsabschnitte; grüner Rand = gutes Bewegungs-Feedback; Triangulation. | In Erprobung |

---

## 3. Technische Umsetzung (Stack & Dateien)

- **Stack:** Vanilla JS, **Vite**-Build, reine statische **PWA**, Deployment auf **Vercel** (Git-Integration, Auto-Deploy aus `main`). Manifest + Service Worker (network-first).
- **Keine externen Frameworks** (kein three.js etc.) – eigener kleiner 3D/Projektions-Code, dependency-frei.

**Dateien (`src/`):**
- `main.js` (~1450 Z.): App-Kern – Kamera, Sensorik, Quaternion-/Projektionsmathematik, State, alle drei Modi, Rendering.
- `audio.js` (`TargetTone`): Mode-B-Audio – **Goertzel** (Amplitude **und Phase** genau einer Zielfrequenz) über ein FFT-Fenster.
- `audioLevel.js` (`LevelMeter`): Mode-C-Audio – RMS + Band-/Ton-**Prominenz**, Geräte-Enumeration, Clipping-/AGC-Verdacht.
- `view3d.js` (`View3D`): unabhängige 3D-Debug-Ansicht (Canvas, Orbit/Zoom).
- `style.css`, `index.html`: UI/Overlays je Modus.

**Sensorik & Geometrie (gemeinsam):**
- **Orientierung** via `DeviceOrientationEvent` (alpha/beta/gamma) + Bildschirmwinkel → **Quaternion** (Kamera-Blickrichtung, Y = oben), absolute Orientierung (Magnetometer) bevorzugt.
- **Beschleunigung** via Generic Sensor API `LinearAccelerationSensor` (60 Hz, schwerkraftfrei) mit **Fallback** `DeviceMotionEvent` (iOS Safari).
- **Projektion:** Welt-Richtung → Kamerakoordinaten (inverses Quaternion) → Bildschirm via geschätztem Sichtfeld (FOV).

---

## 4. Modus A – Sensorstabile AR-Markierung (das „Labor")

- Tippen aufs Kamerabild → speichert **nicht** die Pixelkoordinate, sondern die **Raumrichtung** (Azimut/Elevation) auf einer Kugel um den Nutzer. Beim Drehen verschwindet/erscheint der grüne Punkt korrekt → **3DoF, raumstabil**. *(Das funktioniert zuverlässig.)*
- **Experimentelles 6DoF:** Position aus **doppelter Integration** der Beschleunigung, mit:
  - **Bias-Kalibrierung** (2 s still halten) + **kontinuierlich adaptiver Bias** bei Stillstand,
  - **ZUPT** (Zero-Velocity Update),
  - **zeitbasierter Geschwindigkeits-Dämpfung**.
- **Geführte 5-s-Messung** mit **Loop-Closure**: Annahme Start = Ende → linearer Drift wird über die Zeit herausgerechnet; plus **Start-/Endbild-Vergleich** und **Orientierungs-Fit** als Qualitätsmaße.
- **Unabhängige 3D-Ansicht:** Weg des Handys (Linie), Marker (Punkte), Kugelausschnitt – per Finger drehbar.

**Wichtigste Erkenntnis aus A:** Die **Orientierung** ist gut nutzbar. Die **absolute Position** aus Beschleunigung **driftet stark** (cm–dm in Sekunden) und taugt **nicht** als alleinige Grundlage einer Ortung.

---

## 5. Modus B – Virtuelles Mikrofon-Array (spannend, aber problematisch)

**Idee:** Ein einzelnes bewegtes Mikrofon liefert nacheinander virtuelle Mikrofonpositionen. Aus der **Phasendifferenz** der Zielfrequenz zwischen zwei Positionen A (t1) und B (t2) lässt sich – bei bekannter Bewegungsbasis – ein **Richtungskegel** ableiten; mehrere Kegel schneiden sich zur Quellrichtung.

**Bisher implementiert/erprobt (teils wieder zurückgebaut):**
- Goertzel-Phase je Fenster, virtuelle Paare aus IMU-Positionen, **Konfidenzbänder/Kreise**, Überlagerung → Heatmap.
- **Kohärente Lock-in-Demodulation** (durchlaufender Referenz-Oszillator) statt fenster-weiser Phase → behebt den **Timing-Fehler** (s. u.).
- **ConeBand**-Darstellung statt kamera-zentrierter Einzelauswahl, **Voting**-Akkumulator für ein stabiles Zentrum, **geführte 5-s-Kreismessung + Loop-Closure**.

**Aktueller Stand:** Auf Nutzerwunsch zurück auf die einfache „Kreise"-Variante (live, Goertzel, IMU-Paare). **Ergebnis nicht überzeugend** – siehe Problemanalyse.

---

## 6. Zentrale Probleme & Ursachen (ehrlich)

**P1 – Positionsgenauigkeit vs. Wellenlänge (fundamental):**
Phasenbasiertes Beamforming braucht Positionsgenauigkeit von **< λ/8**. Bei 2–3 kHz ist λ ≈ 11–17 cm → nötig **~1–2 cm**. Die IMU-Position driftet aber im **cm–dm-Bereich**. → Für hohe Frequenzen praktisch **nicht** kohärent ortbar. Tiefe Frequenzen (große λ) sind toleranter.

**P2 – Zeit-Synchronität der Phase (war dominanter Fehler in B):**
Phase muss auf **Bruchteile einer Schwingung** (bei 3 kHz < 0,03 ms) zeitsynchron sein. Fenster-weises Auslesen per `requestAnimationFrame`/`performance.now()` ist nicht sample-genau → die „korrigierte" Phasendifferenz wurde **zufällig**. Behoben durch **Lock-in gegen einen durchlaufenden Referenz-Oszillator** (kohärent, kein Δt-Term). Danach „lief der Punkt durch die Quelle", verschlechterte sich aber über die Zeit (= **Drift**, P1).

**P3 – Phasen-Mehrdeutigkeit (Wrap):**
Bei Bewegung > λ/2 zwischen zwei Messpunkten wird die Laufzeitdifferenz mehrdeutig → falsche Kegel. Bei tiefen Frequenzen unkritisch.

**P4 – Reflexionen/Hall (Industrieumfeld):**
Glatte Flächen erzeugen akustische Spiegelbilder → zusätzliche „Quellen". SoundPointer muss Unsicherheit zeigen, nicht eine harte Position behaupten.

**P5 – Koordinatensysteme:**
Kamera-/Geräte-/Weltsystem müssen sauber getrennt sein. Ein früherer Bug: Eine für die Kameraprojektion gedachte −90°-Korrektur wurde versehentlich auch auf die Beschleunigung angewandt → behoben.

**P6 – Browser-/OS-Audio:**
Trotz `autoGainControl:false` etc. kann Android intern regeln (**AGC-Verdacht** wird angezeigt). Interne Dual-Mikrofone liefern in Chrome meist **kein** echtes Stereo. Zwei getrennte USB-Mikros sind **nicht sample-synchron** → nur für Pegelvergleich, nicht für Phase/TDOA.

---

## 7. Modus C – Akustische HF-Taschenlampe (aktueller MVP)

**Idee:** Das **schwierige Positionsproblem umgehen.** Ein **gerichtetes externes Mikrofon** (RØDE VideoMic Me-C+ per USB-C am S24) liefert die räumliche Trennschärfe physikalisch; die App nutzt **nur die Orientierung** (driftfrei).

**Hörband seit Juli 2026 fest ≥ 12 kHz (12–20 kHz):** Kurze Wellenlängen werden vom Mikrofongehäuse abgeschattet → die Richtwirkung einer kleinen Niere ist im HF-Band am größten, und breitbandiger Industrielärm ist dort meist leise. Unterhalb 12 kHz ist der Modus bewusst taub.

**Donut-Darstellung (Ableitung statt Hotspot):** Zusätzlich zur Pegel-Heatmap wird die **räumliche Ableitung** |dScore/dWinkel| zwischen aufeinanderfolgenden Blickrichtungen gezeichnet (türkis, verblassend). Der Gradient ist auf den **Flanken** um die Quelle maximal und im Maximum null → im Bild entsteht ein **Ring („Donut")** um die Quelle; das dunkle Loch (grüner Punkt = gewichtetes Zentrum) ist die gesuchte Richtung. Die Normierung des Gradienten ist adaptiv (verfallendes Maximum), bei reinem Rauschen entsteht kein Geister-Ring.

**Funktionsweise:**
- Pro Fenster: **Score 0..1** des Zielgeräuschs. **Optionale Zielfrequenz (≥ 12 kHz)** → schmalbandig als **absolute Ton-Prominenz in dB** (Zielband vs. HF-Nachbarband). Ohne Frequenz: HF-Bandpegel 12–20 kHz über einem **adaptiv mitlaufenden Rauschteppich** (Minimum-Tracker).
- **Sample** = `{ t, direction = Blickrichtung, score, quality }`. Alte Samples **verblassen** (Fade-Tau ~4,5 s).
- **Akustisches Zentrum** = `normalize(Σ richtung · score · quality · fade)`.
- **Rendering:** verblassende **Heatmap** (weiche Glüh-Kreise, raumstabil über Orientierung) + grünes **Zentrum** bzw. **Randpfeil** außerhalb des Bildes.
- **HUD:** verwendetes Mikrofon (USB extern ✓/intern), Kanäle, Pegelbalken, Score + Prominenz (dB), Qualität, Zentrums-Konfidenz; Warnungen für **Clipping / AGC / kein Zielton**.
- **Bedienung:** Eingangswahl (externes Mikro wird bevorzugt), Einfrieren, Löschen, Schließen.

**Wichtiger Fix (zuletzt):** Der Score war **relativ** zum gleitenden Maximum normiert → es erschien **immer** ein Hotspot, auch in Stille. Jetzt **absolut** (Prominenz in dB): Rauschen ≈ 0 dB → Score 0 → **kein** Geister-Hotspot.

**Grenzen von C:** Liefert eine **Suchrichtung/Heatmap**, keine exakte 3D-Position. Die Trennschärfe hängt von der **Richtwirkung des Mikrofons** ab (bei tiefen Frequenzen geringer). Reflexionen können mehrere helle Richtungen erzeugen → mehrere Scans aus verschiedenen Standorten helfen.

---

## 8. Priorisierte Roadmap (aus dem letzten Briefing)

- **P0 – Mode C** mit RØDE am S24 als Haupt-MVP. *(umgesetzt, in Erprobung)*
- **P1 – Audio-Hardware-Diagnose:** `enumerateDevices`, Kanäle, `getSettings`/`getCapabilities`, RMS L/R, Korrelation, AGC-Verdacht (für interne/externe Mikros).
- **P2 – Mode C verbessern:** automatische Störton-Erkennung (Peak-Picking), Mikrofonachsen-Kalibrierung, bessere Normalisierung/Quality-Gating.
- **P3 – WebXR/ARCore-Pose** auf S24 testen (markerloses 6DoF im Browser).
- **P4 – Mode B mit stabiler Pose:** AR-Pose oder geführter Scan/Kreisbogenmodell statt freier Beschleunigungsintegration.
- **P5 – Echtes 2-Kanal-USB-Interface** (gemeinsamer Takt) für echte TDOA/Phasenortung.

---

## 9. Offene Konzeptfragen für die Zusammenarbeit

1. **Beste Positionsquelle:** WebXR/ARCore-Pose vs. geführte Bewegung (Kreisbogen) vs. Verzicht (nur Mode C). Was ist auf modernen Geräten praktikabel?
2. **Frequenzbereich:** Realistischer „Sweet Spot" für jeden Modus? (Mode B eher tief; Mode C abhängig vom Mikro.)
3. **Reflexionserkennung:** Wie Mehrdeutigkeit/Hall robust als „Messunsicherheit" statt Fehlanzeige darstellen (SCI – Spatial Coherence Indicator)?
4. **Hardware:** Lohnt ein echtes 2-Kanal-USB-Interface (feste Geometrie, gemeinsamer Takt) für phasenbasierte Ortung gegenüber dem Taschenlampen-Ansatz?
5. **Auto-Tonerkennung:** Peak-Picking des „neuen" auffälligen Tons, statt manueller Frequenzeingabe.

---

## 10. Kernbotschaft

> Die ursprüngliche Idee (virtuelles Array aus einem bewegten Handy-Mikro) ist physikalisch reizvoll, scheitert aber an **Positionsgenauigkeit** und **Zeitsynchronität**. Der pragmatische, funktionierende Weg ist die **akustische Taschenlampe** (gerichtetes Mikro + Orientierung + verblassende Heatmap). Sie ortet nicht exakt, **grenzt die Suche aber wirksam ein** – und der Mensch entscheidet.
