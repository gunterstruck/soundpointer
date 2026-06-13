# SoundPointer

Eine PWA, die langfristig Geräuschquellen im Raum lokalisieren und als
frequenzselektive akustische Heatmap darstellen soll. Bevor Audio verarbeitet
wird, muss die räumliche Orientierung zuverlässig funktionieren.

## Milestone 1 – Sensorstabile AR-Markierung

Validiert, ob eine PWA auf dem Smartphone eine **stabile Richtungsreferenz** im
Raum aufbauen kann. Der Benutzer tippt auf das Kamerabild; gespeichert wird
**nicht** die Bildschirmkoordinate, sondern die zugehörige **Raumrichtung**
(Azimut/Elevation auf einer virtuellen Kugel um den Benutzer). Dreht man sich
weg und wieder zurück, erscheint der Marker an derselben realen Position.

> Audio wird in diesem Meilenstein bewusst noch nicht verwendet.

### Funktionen

- Vollbild-Kamerabild der **rückseitigen** Kamera (`getUserMedia`)
- Transparenter **Overlay-Layer** mit Fadenkreuz und grünen Markern (~20 px)
- Sensorik über `DeviceOrientationEvent` (alpha/beta/gamma), mit **bevorzugter
  absoluter Orientierung** (`deviceorientationabsolute` / Magnetometer)
- **Tippen** setzt einen Marker als Raumrichtung; mehrere Marker möglich
- Marker verschwinden beim Wegdrehen und erscheinen beim Zurückdrehen wieder
- Debug-Anzeige: Quelle, Azimut, Pitch, Roll, Markeranzahl
- Installierbare **PWA** (Manifest + Service Worker, offline-fähig)

### Technischer Ansatz

1. Geräteorientierung (`alpha/beta/gamma` + Bildschirmwinkel) → **Quaternion**
   der Kamera-Blickrichtung (Weltkoordinaten, Y = oben).
2. Tipp → Strahl im Kamerakoordinatensystem (über geschätztes Sichtfeld) →
   per Quaternion in eine **Weltrichtung** → gespeichert als **Azimut/Elevation**.
3. Rendern: gespeicherte Weltrichtung mit invertiertem aktuellem Quaternion
   zurück ins Kamerasystem projizieren → Bildschirmposition.

Das genaue Sichtfeld ist für die Wiederauffindbarkeit unkritisch – bei
identischer Orientierung kürzt es sich heraus; es beeinflusst nur die
Genauigkeit während der Drehung.

### Ausführen

Kamera- und Sensorzugriff erfordern einen **sicheren Kontext (HTTPS)** bzw.
`localhost`. Ein beliebiger statischer Server genügt:

```bash
# z. B. mit Python
python3 -m http.server 8000
# dann auf dem Smartphone (gleiches Netz / via HTTPS-Tunnel) öffnen
```

Auf dem Smartphone die Seite öffnen, **„Starten"** tippen und Kamera- sowie
Bewegungssensor-Zugriff erlauben (iOS fragt explizit nach).

### Deployment auf Vercel

Die App ist eine rein **statische PWA** (kein Build-Schritt). `vercel.json`
konfiguriert das Projekt als statisches Hosting („Other") und setzt
PWA-freundliche Header (Service-Worker-Scope, Manifest-Content-Type,
`Permissions-Policy` für Kamera/Gyroskop/Beschleunigung/Magnetometer).
Vercel liefert automatisch HTTPS – Voraussetzung für Kamera- und Sensorzugriff.

**Einrichtung (einmalig, wie beim Schwesterprojekt – Git-Integration):**

1. In Vercel **„Add New… → Project"** und das Repo `gunterstruck/soundpointer`
   importieren.
2. **Framework Preset:** `Other` (kein Build nötig). Build/Install/Output bleiben
   leer – das übernimmt bereits `vercel.json`.
3. **Production Branch:** `main`. Deployen.

Danach löst jeder Push nach `main` automatisch ein Deployment aus; Pushes auf
andere Branches/PRs erzeugen Preview-Deployments.

### Erfolgsdefinition

1. Kamera läuft stabil ✔
2. Sensoren werden ausgelesen ✔
3. Marker per Fingertipp setzbar ✔
4. Marker als Raumrichtung gespeichert ✔
5. Marker verschwinden beim Wegdrehen ✔
6. Marker erscheinen beim Zurückdrehen wieder ✔

### Zu beobachtende Erkenntnisse

- Stabilität der Sensoren in der PWA, Drift der Orientierung
- Reicht das Gyroskop, oder wird das Magnetometer benötigt?
- Überzeugt die Benutzererfahrung als Grundlage der späteren Audio-Lokalisierung?

## Projektstruktur

```
index.html              App-Shell + Overlay
css/style.css           Layout, Marker, Fadenkreuz, Debug-UI
js/app.js               Orientierungs-/Projektionsengine, Sensorik, Kamera
manifest.webmanifest    PWA-Manifest
sw.js                   Service Worker (Offline-Cache)
icons/icon.svg          App-Icon
```
