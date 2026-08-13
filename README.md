# RemNote Card Exporter Plugin

Ein automatisches Hintergrund-Plugin für **RemNote**, das deine Karteikarten während des Lernens (Queue) in Echtzeit ausliest und per HTTP-POST-Request an eine lokale Schnittstelle (z. B. eine Swift- oder Backend-App) sendet.

---

## ✨ Features

* ⚡ **Echtzeit-Synchronisierung:** Erkennt automatisch das Laden (`queue.load-card`) und Aufdecken (`queue.reveal-answer`) von Karteikarten.
* 🛡️ **Duplikat-Schutz:** Verhindert mehrfaches Senden derselben Karte durch intelligente ID-Prüfung (`lastSentCardId`).
* 📝 **Sichere RichText-Konvertierung:** Wandelt RemNote-RichText-Objekte und Arrays zuverlässig in sauberen Klartext um.
* 🔄 **Hintergrund-Intervall:** Ein automatischer Fallback-Check (jede Sekunde) sorgt dafür, dass keine Karte verloren geht.
* 🔔 **Visuelles Feedback:** Zeigt eine dezent Toast-Benachrichtigung in RemNote an, sobald eine Karteikarte erfolgreich übertragen wurde.

---

## 🛠️ Funktionsweise

Sobald eine Karteikarte in RemNote geladen oder aufgedeckt wird, extrahiert das Plugin die wichtigsten Daten und sendet sie als **JSON-Payload** per `POST`-Request an den lokalen Endpoint:

📍 **Standard-Ziel:** `http://127.0.0.1:8000`

### 📦 Sende-Format (JSON Payload)

```json
{
  "cardId": "pB8xY9zQ...",
  "remId": "aK3mL5nR...",
  "front": "Was ist die Hauptfunktion von RemNote Exporter?",
  "back": "Karten automatisch an eine externe App zu senden.",
  "timestamp": 1718000000000
}
```

---

## 🚀 Installation & Entwicklung

### Voraussetzungen

* [Node.js](https://nodejs.org/) (Version 16 oder höher empfohlen)
* `npm` oder `yarn`

### Quickstart

1. **Repository klonen:**
   ```bash
   git clone https://github.com/benjaminboehringer01-web/remnote-card-exporter.git
   cd remnote-card-exporter
   ```

2. **Dependendies installieren:**
   ```bash
   npm install
   ```

3. **Plugin bauen:**
   ```bash
   npm run build
   ```
   *Erstellt das fertige Zip-Archiv (`PluginZip.zip`) zur Einbindung in RemNote.*

---

## ⚙️ Konfiguration

Wenn du die Ziel-URL deines Empfängers ändern möchtest, kannst du die Variable in `src/widgets/index.tsx` anpassen:

```typescript
// src/widgets/index.tsx
const DESTINATION_URL = 'http://127.0.0.1:8000'; // Hier deine URL / Port eintragen
```

---

## 📂 Projektstruktur

```text
.
├── public/
│   └── manifest.json     # Plugin-Manifest & Metadaten
├── src/
│   └── widgets/
│       └── index.tsx     # Hauptlogik (Queue-Listener & HTTP-Sync)
├── package.json
└── README.md
```

---

## 👤 Autor

**Benjamin Böhringer**
* GitHub: [Benjaminboehringer01-web](https://github.com/benjaminboehringer01-web)
