import { defineConfig } from 'vite';

// SoundPointer ist eine vanilla-JS PWA. Vite bündelt src/ (main.js + style.css);
// statische PWA-Dateien (manifest.webmanifest, sw.js, icons/) liegen in public/
// und werden unverändert ins Ausgabeverzeichnis (dist/) kopiert.
export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
  server: {
    host: true, // im LAN erreichbar (Test auf dem Smartphone)
  },
});
