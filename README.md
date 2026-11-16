# Finanzen

Persönliches Haushaltsbuch als Handy-App (PWA). Ausgaben und Einnahmen eintragen,
Fixkosten wie Versicherungen und Abos einmal anlegen, Monats- und Jahresübersicht.

**Alle Daten bleiben auf dem Gerät.** Es gibt keinen Server, kein Konto und keine
Statistik. Die Sicherheitsregel in `index.html` (Content-Security-Policy) verbietet
der App technisch, irgendetwas ins Internet zu senden. In diesem Repository liegt
nur der Programmcode, keine Finanzdaten.

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
| `js/app.js` | Oberfläche |
| `sw.js` | Offline-Betrieb |
| `tests/logic.test.mjs` | Tests der Rechenlogik: `npm test` |
| `tools/make_icons.py` | erzeugt die App-Icons |

**Bei jeder Änderung** an einer App-Datei die `VERSION` in `sw.js` und
`APP_VERSION` in `js/app.js` erhöhen, sonst bekommt das Handy die neue Version
nicht. Die App meldet dann „Neue Version verfügbar“.

Lokal testen: `python -m http.server 8765` im Ordner, dann `http://127.0.0.1:8765`
(ohne Offline-Zwischenspeicher) oder `http://localhost:8765` (mit).
