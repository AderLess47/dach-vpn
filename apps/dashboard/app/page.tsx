import { DeviceConsole } from "../components/device-console";
import { getRequestBrand } from "../lib/brand";

export default async function HomePage() {
  const brand = await getRequestBrand();

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-400">
          {brand.name} · Auth + Zero-Knowledge-PoC
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

      <DeviceConsole brand={brand} />

      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 text-sm text-slate-400">
        <h2 className="mb-2 font-medium text-slate-200">Was hier noch fehlt</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Stripe läuft ohne konfigurierte Preise im Trockenlauf: Checkout und Portal
            antworten dann mit HTTP 202 statt mit einer Zahlungsseite.
          </li>
          <li>
            Die deutschen Auth-Mails liegen unter{" "}
            <code className="rounded bg-slate-900 px-1 py-0.5 text-xs text-slate-300">
              supabase/templates
            </code>
            , müssen aber noch im Supabase-Projekt hinterlegt werden.
          </li>
          <li>
            Die Kennzahlen unter{" "}
            <a className="text-sky-400 hover:text-sky-300" href="/admin">
              /admin
            </a>{" "}
            sehen nur Konten, die in{" "}
            <code className="rounded bg-slate-900 px-1 py-0.5 text-xs text-slate-300">
              ADMIN_USER_IDS
            </code>{" "}
            stehen.
          </li>
        </ul>
      </section>
    </main>
  );
}
