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

### Ausführen (lokal)

Das Projekt nutzt **Vite**. Kamera- und Sensorzugriff erfordern einen
**sicheren Kontext (HTTPS)** bzw. `localhost`.

```bash
npm install      # Abhängigkeiten installieren
npm run dev      # Dev-Server (im LAN erreichbar: host aktiviert)
npm run build    # Produktions-Build nach dist/
npm run preview  # gebautes dist/ lokal testen
```

Zum Test auf dem Smartphone den Dev-Server im gleichen Netz öffnen (oder ein
HTTPS-Tunnel), **„Starten"** tippen und Kamera- sowie Bewegungssensor-Zugriff
erlauben (iOS fragt explizit nach).

### Deployment auf Vercel

Vite-Projekt mit **Git-Integration** (gleiches Prinzip wie das Schwesterprojekt):
Vercel führt bei jedem Push `npm run build` aus und veröffentlicht `dist/`.
`vercel.json` setzt zusätzlich PWA-freundliche Header (Service-Worker-Scope,
Manifest-Content-Type, `Permissions-Policy` für Kamera/Gyroskop/Beschleunigung/
Magnetometer). HTTPS liefert Vercel automatisch – Voraussetzung für Kamera/Sensoren.

**Einrichtung (einmalig):**

1. In Vercel **„Add New… → Project"** und das Repo `gunterstruck/soundpointer`
   importieren.
2. **Framework Preset:** `Vite` (wird automatisch erkannt) – Build `npm run build`,
   Output `dist`.
3. **Production Branch:** `main`. Deployen.

Danach löst jeder Push nach `main` automatisch ein Production-Deployment aus;
Pushes auf andere Branches/PRs erzeugen Preview-Deployments.

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
index.html                   Vite-Entry + Overlay-Markup
src/main.js                  Orientierungs-/Projektionsengine, Sensorik, Kamera
src/style.css                Layout, Marker, Fadenkreuz, Debug-UI (via main.js importiert)
public/manifest.webmanifest  PWA-Manifest  (unverändert ins dist/-Root kopiert)
public/sw.js                 Service Worker (Offline-Cache)
public/icons/icon.svg        App-Icon
vite.config.js               Build-Konfiguration
vercel.json                  Vercel-Deploy-Konfiguration (Vite + Header)
package.json                 Scripts & Abhängigkeiten
```
