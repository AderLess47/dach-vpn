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

## Marke (White-Label)

Der Anzeigename steht **nicht** fest im HTML, sondern kommt aus dem Brand-Modul
(`packages/shared/src/brand.ts`) — dieselbe Quelle wie Metadata, UI und
Dateiname der WireGuard-Config. Im HTML markieren Kommentare die Stellen:

```html
<!-- brand:name -->HubGuard<!-- /brand:name -->
<!-- brand:footer -->HubGuard · No-Log-VPN mit Pi-hole-Add-on<!-- /brand:footer -->
```

Supabase speichert die Vorlagen als statisches HTML und kann dort keine
Umgebungsvariablen einsetzen. Deshalb rendert ein Skript die Marke hinein:

```bash
bun run mail:render                                  # Default (HubGuard)
NEXT_PUBLIC_APP_NAME="Acme VPN" bun run mail:render  # Mandant
bun run mail:check                                   # prüft nur, Exit 1 bei Abweichung
```

`mail:check` läuft in der CI und schlägt fehl, sobald eine Vorlage nicht zur
Marke passt — etwa nach einer Änderung an `brand.ts` ohne erneutes Rendern.
Die Marker bleiben in der Datei, damit ein zweiter Lauf mit anderer Marke
wieder greift. Es sind HTML-Kommentare, die Supabase beim Rendern entfernt
(Go `html/template`) — in der zugestellten Mail steht nur der Name.

Nur der Name und die Fußzeile sind markenabhängig. Betreffzeilen, Texte und
Farben bleiben bewusst gleich — ein Mandant ändert die Marke, nicht die
Sicherheitshinweise.

## Gehostetes Projekt

Die Dashboard-Vorlagen sind von der Konfigurationsdatei getrennt. Pro Mail:
**Supabase → Authentication → Email Templates**, Eintrag wählen, Betreff aus der
Tabelle oben eintragen und den Inhalt der HTML-Datei einfügen — die komplette
Datei von `<!doctype html>` bis `</html>`, nicht nur den sichtbaren Text. Dann
**Save**; die nächste Registrierung bzw. der nächste Reset verschickt die
deutsche Fassung. Bereits verschickte Mails ändern sich nicht.

| Eintrag im Dashboard | Datei | Betreff |
|---|---|---|
| Confirm signup | `confirmation.html` | Bestätige deine E-Mail-Adresse |
| Reset password | `reset-password.html` | Passwort zurücksetzen |

Zum Kopieren genügt `cat supabase/templates/confirmation.html` (bzw.
`reset-password.html`). Die Marker-Kommentare dürfen mitkopiert werden.

Die Links stammen aus `{{ .ConfirmationURL }}` und werden gegen die `site_url`
des Projekts gebaut. Steht dort noch `http://localhost:3000`, führt der Klick
ins Leere — `site_url` und `uri_allow_list` gehören deshalb mit den Vorlagen
gesetzt (**Authentication → URL Configuration**).

## Marke ändern — Checkliste

1. `NEXT_PUBLIC_APP_NAME` setzen (lokal in `.env`, für das gehostete Dashboard
   als Projekt-Secret) und `bun run mail:render` ausführen.
2. `bun run mail:check` muss grün sein; `git diff` zeigt nur die Marken-Zeilen.
3. Beide Dateien im Dashboard neu einfügen und **Save** drücken — ohne diesen
   Schritt verschickt das Projekt weiter die alte Fassung.
4. **Authentication → URL Configuration**: `site_url` und `uri_allow_list` auf
   die Domain des Mandanten umstellen.
5. **Project Settings → Auth → SMTP**: Absendername auf die Marke ändern; die
   Absenderadresse bleibt die verifizierte Domain.
6. Testmail auslösen (Registrierung oder Passwort-Reset) und prüfen, dass
   Kopfzeile und Fußzeile die neue Marke zeigen.

Jeder Mandant hat sein eigenes Supabase-Projekt und damit eigene Vorlagen. Die
Marke wird pro Projekt gerendert und eingefügt; unterschiedliche Marken
innerhalb eines Projekts sind nicht vorgesehen. Nicht vergessen: eine Änderung
der Marke ist erst vollständig, wenn Dashboard-Build **und** Mail-Vorlagen
neu erzeugt sind.

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
