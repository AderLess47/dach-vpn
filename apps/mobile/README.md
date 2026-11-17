# React-Native-Basis (Gerüst)

Dieses Verzeichnis ist der Platzhalter für die gemeinsame Client-Codebasis aus M3
(iOS, tvOS, Android, Fire TV). Es ist **bewusst nicht** Teil der Bun-Workspaces:
Die React-Native-Toolchain bringt mehrere hundert Megabyte Abhängigkeiten mit und
würde CI verlangsamen, ohne in Sprint 0 etwas zu prüfen.

## Aktivierung mit M3

1. `npx @react-native-community/cli init DachVpn --directory apps/mobile` (oder
   Expo, falls wir uns dafür entscheiden)
2. `apps/mobile` in `workspaces` der Root-`package.json` aufnehmen
3. `@dachvpn/crypto` und `@dachvpn/shared` als Workspace-Abhängigkeiten eintragen
4. Native Module ergänzen: `NetworkExtension` (iOS/tvOS), `VpnService` + WireGuard
   GoBackend (Android/Fire TV)

## Bereits festgelegt (damit die Ordnerstruktur passt)

- Zustand als State-Manager
- gemeinsame UI-Komponenten und TV-Fokus-Navigation in dieser App
- kein eigener Krypto-Code in der App: `@dachvpn/crypto` wird wiederverwendet
