# Auth-Mail-Vorlagen

Deutsche Vorlagen für die beiden Mails, die Supabase Auth selbst verschickt.
Beide sind eigenständige HTML-Dateien ohne externe Bilder, Schriften oder
Tracking-Pixel — passend zur No-Log-Zusage.

| Datei | Supabase-Typ | Betreff |
|---|---|---|
| `confirmation.html` | `confirmation` | Bestätige deine E-Mail-Adresse |
| `reset-password.html` | `recovery` | Passwort zurücksetzen |

## Lokal

`supabase/config.toml` verweist bereits auf beide Dateien; `supabase start`
nutzt sie, und die Mails landen im lokalen Inbucket (Port 54324). Die Pfade
gelten ab der Projektwurzel.

## Gehostetes Projekt

Die Dashboard-Vorlagen sind von der Konfigurationsdatei getrennt. Pro Mail:
**Supabase → Authentication → Email Templates**, Vorlage wählen, Betreff aus der
Tabelle oben eintragen und den Inhalt der HTML-Datei einfügen.

## Variablen

Verwendet wird ausschließlich `{{ .ConfirmationURL }}` — bei beiden Typen der
Link, der die Aktion ausführt. Supabase stellt zusätzlich `{{ .Token }}` (der
6-stellige Code), `{{ .Email }}` und `{{ .SiteURL }}` bereit; die Vorlagen
verzichten bewusst darauf, damit in der Mail keine Kontodaten stehen.

## Gestaltung

Farben und Typografie folgen dem Dashboard: Karte auf hellem Grund, Kopfzeile in
`#0b1120`, Akzent `#0284c7` (Sky). Änderungen an den Farben bitte in beiden
Dateien gleich halten. Auf Tabellen-Layout und Inline-Styles wurde bewusst nicht
verzichtet — Mail-Clients ignorieren `<style>`-Blöcke und moderne Layouts.
