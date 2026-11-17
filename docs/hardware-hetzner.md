# Hardware und Netz für den ersten M2-Testknoten (Hetzner)

Ziel: ein Knoten, auf dem wir **iPXE-Boot aus dem RAM** und den **Pull-Agenten**
real testen können — inklusive Kaltstart-Test (Stromausfall → Konvergenz < 2 min).

## 0. Entscheidung (Stand 17.11.2026)

**Hetzner, Standort Falkenstein/Nürnberg.** Der vSwitch ist ein echtes
Layer-2-Segment zwischen dedizierten Servern mit frei wählbaren privaten IPs;
ein zusätzlich bestelltes Subnetz lässt sich darauf routen, und eine
Cloud-Instanz wird über „Netzwerke → Subnetz → Enable dedicated server vSwitch
connection“ in dasselbe Segment gehängt. Damit läuft der PXE-Boot-Server
(DHCP/TFTP/HTTP) in einem L2-Netz, in dem wir DHCP kontrollieren; auf dem
öffentlichen Uplink bleibt DHCP aus. Hetzner beschreibt genau dieses Vorgehen
selbst (DHCP-Scope auf dem Subnetz, PXE-Optionen 66/67).

**Fallback: OVHcloud.** vRack ist ein kostenloses L2-Netz über Regionen, dazu
IPMI und Rescue. OVH dokumentiert DHCP/TFTP im privaten Netz auch für
OLA-Setups (nur private Interfaces) — dort entfällt allerdings der
Standard-Netboot, sobald ein Server ausschließlich privat angebunden ist.

**Nicht geeignet:** reine Cloud-Produkte ohne L2-Segment und ohne eigenes
Subnetz am Switch — dort ist kein reproduzierbarer Kaltstart-Test möglich.

**Bestellung und Abrechnung** laufen über den Account des Auftraggebers. Von
uns kommen Spezifikation, Bootstrap und Messprotokoll; eine eigene
Rechnungsstellung ist nicht Teil der Leistung.

## 1. Mindestanforderungen (dediziert, nicht Cloud-vCPU)

| Komponente | Anforderung | Begründung |
|---|---|---|
| CPU | ≥ 8 dedizierte Kerne, x86-64, AES-NI | WireGuard ist CPU-gebunden; geteilte vCPU verfälscht den Lasttest |
| RAM | ≥ 32 GB ECC (empfohlen 64 GB) | Betriebssystem + AdGuard + Peers laufen **ausschließlich im RAM**; kein Swap |
| Disk | 2 × ≥ 512 GB NVMe/SSD | Nur für Rescue/ISO/Hilfsdaten — der Knoten selbst braucht keine Persistenz |
| Netz | 1 Gbit/s dediziert, IPv4 + IPv6 (/64), ungefiltert | VPN-Durchsatz, IPv6 für Smart DNS |
| Out-of-Band | IPMI/BMC oder KVM-Konsole | Kaltstart-Test und Bootreihenfolge ohne Support-Ticket |
| Boot | UEFI **und** Legacy, PXE-fähig, CSM abschaltbar | iPXE-Chainload; UEFI-Umstellung erfordert KVM |
| Standort | EU (DE/FI), DSGVO-konform | No-Log-Zusage, Auftragsverarbeitung |

## 2. Wichtige Einschränkung: PXE bei Hetzner

Hetzner bootet **dedizierte Server über das eigene Rescue-System per PXE**. Ein
eigenes iPXE-Image lässt sich darüber nicht laden; auf dem öffentlichen Netz
hast du keine Kontrolle über DHCP/TFTP.

Für den M2-Test gibt es deshalb zwei belastbare Wege:

| Weg | Vorgehen | Geeignet für |
|---|---|---|
| **A. Boot-Server im vSwitch** (empfohlen) | Kleine Cloud-Instanz als PXE-Boot-Server (DHCP/TFTP/HTTP) + vSwitch + eigenes Subnetz (/29). Der dedizierte Server hängt im selben vSwitch-Netz und bezieht PXE von unserem Server. | wiederholbare Kaltstart-Tests, späterer Produktions-PXE |
| **B. KVM-Konsole + virtuelles Medium** | iPXE-ISO über die KVM-Konsole einbinden, einmalig booten | Einzeltests, wenn kein vSwitch gewünscht ist |

Wichtig für Weg A: Das Subnetz muss am vSwitch anliegen, und der Boot-Server
braucht eine feste IP darin. Der dedizierte Server bekommt eine
**DHCP-Reservation auf seine MAC** — sonst ist der Kaltstart-Test nicht
reproduzierbar.

Das gilt ausdrücklich nur für das Labor. DHCP ist link-local: ein Boot-Server im
Rechenzentrum erreicht kein Gerät im Kundennetz. Für die Auslieferung an
Kunden braucht es deshalb ein Medium vor Ort (Bootstick oder DHCP-Proxy im
Staging-VLAN), das per HTTPS in die Boot-Menüs des Control-Plane chainloadet —
kein DHCP über das Internet.

Quellen: Hetzner Docs zu Rescue-System (PXE), vSwitch/Subnetz-DHCP und
KVM-Konsole.

## 3. Bestellliste für den Test (Vorschlag)

| Position | Zweck | Hinweis |
|---|---|---|
| 1 × dedizierter Server der AX-Klasse (AMD, ≥ 8 Kerne, ≥ 32 GB) | VPN-Knoten, RAM-only | Modell und Preis im Robot-Portal prüfen; Auction-Server sind für den Test ausreichend |
| 1 × kleine Cloud-Instanz (2 vCPU, 4 GB) | PXE-Boot-Server, AdGuard-Testinstanz | monatlich kündbar |
| 1 × vSwitch + 1 × Subnetz (/29) | Bootnetz, OOB-Trennung | Hetzner-Produkt „vSwitch" + „Subnetz" |
| IPv6 /64 | Pflicht für Smart DNS und AAAA-Tests | beim Server bestellen |

Kostenrahmen: grob 60–120 €/Monat für Server + Boot-Instanz + vSwitch, je nach
Modell und Laufzeit. Verbindliche Preise stehen im Hetzner-Portal (Stand 11/2026
hier bewusst nicht fortgeschrieben).

## 4. Zugänge, die wir von dir brauchen

1. **Robot-Zugang** (Hetzner-Root-Server-Verwaltung) mit Rechten für
   Rescue-System, KVM-Konsole und Neuinstallation — oder du führst die
   Rescue-Umschaltung auf Zuruf aus.
2. **Server-Details:** öffentliche IPv4/IPv6, MAC-Adresse, Switch-Port,
   Subnetz, vSwitch-Name.
3. **Root-Zugang** (SSH-Key, kein Passwort-Login) für die Erstinstallation.
4. **KVM-Konsole** für die Umstellung auf UEFI (CSM aus) — einmalig nötig.

## 5. Was wir damit zuerst messen

- iPXE → Alpine-Image → Agent-Start: Zeit bis „Interface up"
- 1.000 Peers im Sollzustand, Agent-Zyklus ≤ 5 s
- Kaltstart (Power-Off → Power-On) bis Konvergenz, 10 Durchläufe
- nftables-Regelsatz je Peer inkl. Pi-hole-Umschaltung ≤ 60 s

Diese vier Messungen sind die Abnahmebasis aus AP 2.11 und 5.4.
