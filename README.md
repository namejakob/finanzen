# Finanzen

Persönliches Haushaltsbuch als Handy-App (PWA). Ausgaben und Einnahmen eintragen,
Fixkosten wie Versicherungen und Abos einmal anlegen, Monats- und Jahresübersicht.

**Die Daten gehören dem Gerät.** Kein Konto, keine Statistik, keine fremden Dienste.
Die Sicherheitsregel in `index.html` (Content-Security-Policy) erlaubt der App nur,
mit ihrer eigenen Adresse zu sprechen. In diesem Repository liegt nur der
Programmcode, keine Finanzdaten.

Adresse: **https://finanzen.jakobg.de** (eigener Server, mit Abgleich).
Die Kopie auf GitHub Pages (`namejakob.github.io/finanzen`) läuft ohne Abgleich.

## Abgleich Handy ↔ Laptop

Optional, unter „Mehr“. Das erste Gerät erzeugt einen zufälligen **Sync-Schlüssel**
(32 Zeichen), weitere Geräte verbinden sich damit. Aus dem Schlüssel werden
Speicherplatz-Name, Zugangscode und ein AES-256-Schlüssel abgeleitet (HKDF).
Verschlüsselt wird **auf dem Gerät**; der Server speichert nur den verschlüsselten
Block und eine Prüfsumme des Zugangscodes und kann nichts lesen.

Abgleich als Drei-Wege-Vergleich gegen den letzten gemeinsamen Stand: Wer einen
Eintrag geändert hat, gewinnt; haben beide geändert, gewinnt das Gerät, das gerade
abgleicht; Löschen gegen Ändern behält die Änderung. Fixkosten-Buchungen haben feste
IDs (`<vertrag>@<datum>`), damit zwei Geräte dieselbe Zahlung nicht doppelt buchen.
Der Server hebt die letzten 30 Stände auf.

**Schlüssel verloren = Server-Daten verloren.** Die Daten auf den Geräten bleiben,
und die Sicherungsdatei funktioniert unabhängig davon.

## Installieren (Android)

1. Die App-Adresse in Chrome öffnen.
2. Menü (⋮) → **App installieren** bzw. **Zum Startbildschirm hinzufügen**.
3. Ab dann startet sie wie eine normale App, auch ohne Internet.

## Funktionen

- **Eintragen** über den großen Plus-Knopf: Betrag, Kategorie antippen, fertig.
  Häufige Notizen erscheinen als Schnellwahl, und eine Notiz merkt sich ihre Kategorie.
- **Fixkosten**: Versicherungen, Abos, Miete, Gehalt mit Intervall (monatlich,
  vierteljährlich, halbjährlich, jährlich). Werden am Fälligkeitstag automatisch
  gebucht. Anzeige pro Monat und pro Jahr, dazu der Betrag, den man monatlich für
  Jahres- und Quartalszahlungen zurücklegen sollte.
- **Übersicht**: Monat oder Jahr, Übrig, Sparquote, Ausgaben nach Kategorie,
  Monatsdiagramm, demnächst fällige Zahlungen.
- **Sparen & Anlegen** zählt nicht als Ausgabe, sondern wird als „Gespart“ ausgewiesen.
- **Sicherung** als JSON-Datei speichern und laden (ersetzen oder ergänzen),
  Export als CSV für Excel. Erinnerung nach 30 Tagen ohne Sicherung.

## Technik

Reines HTML, CSS und JavaScript ohne Bibliotheken und ohne Build-Schritt.

| Datei | Inhalt |
|---|---|
| `js/logic.js` | Rechenlogik (Geld in Cent, Datum, Fixkosten, Auswertung, Sicherung) |
| `js/store.js` | Speicher im Gerät (IndexedDB) |
| `js/sync.js` | Abgleich: Schlüssel, Verschlüsselung, Drei-Wege-Abgleich |
| `js/app.js` | Oberfläche |
| `sw.js` | Offline-Betrieb |
| `server/server.mjs` | Server: liefert die App aus, speichert verschlüsselte Blöcke (nur Node, keine Pakete) |
| `server/compose.yaml` | Betrieb auf dem Hetzner-Server hinter Caddy |
| `tests/` | Tests für Rechenlogik, Abgleich und Server: `npm test` |
| `tools/make_icons.py` | erzeugt die App-Icons |

**Bei jeder Änderung** an einer App-Datei die `VERSION` in `sw.js` und
`APP_VERSION` in `js/app.js` erhöhen, sonst bekommt das Handy die neue Version
nicht. Die App meldet dann „Neue Version verfügbar“.

Lokal testen: `node server/server.mjs 8766`, dann `http://127.0.0.1:8766`
(ohne Offline-Zwischenspeicher) oder `http://localhost:8766` (mit). Beide Adressen
zählen als getrennte Geräte, so lässt sich der Abgleich ausprobieren.

Server aktualisieren: auf dem VPS `cd ~/finanzen/app && git pull`, dann
`cd ~/finanzen && docker compose restart`.
