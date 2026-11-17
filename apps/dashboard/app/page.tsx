import { DeviceConsole } from "../components/device-console";

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-400">
          Sprint 1 · Auth + Zero-Knowledge-PoC
        </p>
        <h1 className="text-3xl font-semibold text-slate-50">
          Curve25519-Schlüssel im Browser, Public Key an den Server
        </h1>
        <p className="text-slate-300">
          Das Schlüsselpaar entsteht ausschließlich im Browser. Der Server
          verifiziert deine Sitzung, weist dem Konto ein Gerät mit Adresse aus
          dem Pool zu und bekommt ausschließlich den Public Key. Jeder Payload
          mit privatem Schlüsselmaterial wird mit HTTP 422 abgewiesen — vor jeder
          Validierung, Speicherung oder Protokollierung.
        </p>
        <a className="text-sm text-sky-400 hover:text-sky-300" href="/admin">
          → Admin-Kennzahlen
        </a>
      </header>

      <DeviceConsole />

      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 text-sm text-slate-400">
        <h2 className="mb-2 font-medium text-slate-200">
          Was dieser PoC bewusst nicht enthält
        </h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>kein Stripe-Checkout (folgt nach der Schema-Abnahme)</li>
          <li>keine E-Mail-Vorlagen/Branding für Auth-Mails</li>
          <li>kein Widerrufs-Endpunkt im UI (Funktion existiert serverseitig)</li>
        </ul>
      </section>
    </main>
  );
}
