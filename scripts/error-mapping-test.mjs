#!/usr/bin/env bun
/**
 * Fehlerabbildung gegen echte Postgres-Fehler (Migrationen 0001–0009).
 *
 * Die Unit-Tests prüfen `describeDeviceFailure` gegen erfundene Meldungen. Hier
 * wird der Weg andersherum gegangen: die Datenbank wirft die Fehler wirklich,
 * und die Abbildung muss daraus den vereinbarten HTTP-Vertrag machen. Damit
 * fällt auf, wenn eine Migration ihren Marker umbenennt oder einen neuen
 * `raise exception` einführt, den niemand abbildet.
 *
 * Geprüft wird:
 * - für jeden RPC-Marker: SQLSTATE, Marker im Text und die abgebildete Antwort,
 * - dass nach außen nie der DB-Text oder ein SQLSTATE erscheint,
 * - die beiden Constraint-Fälle 23505/23503 (defensiv: die RPC fängt sie vorher
 *   als P0004 bzw. gar nicht ab),
 * - Vollständigkeit: jeder `raise exception` der Migrationen ist entweder
 *   abgebildet oder bewusst als nicht-Gerätefehler eingetragen.
 *
 * ACHTUNG: setzt das Schema zurück. Nie gegen Produktion laufen lassen.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeDeviceFailure } from "../packages/shared/src/device-errors.ts";
import { createChecker, createTestUser, fakePublicKey, migrate } from "./lib/db-fixture.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = "eu-map-1";
const FULL_NODE = "eu-map-full";

/** Marker, die absichtlich nicht zu einer HTTP-Antwort führen. */
const KNOWN_UNMAPPED = new Set([
  "POOL_TOO_SMALL", // Konfigurationsfehler beim Anlegen des Pools, nicht pro Request
  "USER_ID_REQUIRED", // Aufruf ohne Nutzer-ID im Stripe-Sync, kein Gerätefehler
]);

const { check, finish } = createChecker();

async function register(db, userId, index, options = {}) {
  const { pihole = false, node = NODE, limit = 20 } = options;
  const { rows } = await db.query(
    "select * from public.register_device($1, $2, 'web', $3, $4, $5, $6)",
    [userId, `Gerät ${index}`, fakePublicKey(index), node, pihole, limit],
  );
  return rows[0];
}

async function rebind(db, userId, deviceId, index) {
  const { rows } = await db.query("select * from public.rebind_device_key($1, $2, $3)", [
    userId,
    deviceId,
    fakePublicKey(index),
  ]);
  return rows[0];
}

async function subscribe(db, userId, status, pihole = false) {
  await db.query(
    "select * from public.apply_subscription_state($1, $2, $3, $4, $5, null, false)",
    [userId, `cus_${userId.slice(0, 8)}`, `sub_${userId.slice(0, 8)}`, status, pihole],
  );
}

/** Führt den Aufruf aus und gibt den echten Fehler zurück (oder null). */
async function failure(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

async function main() {
  const db = await migrate();
  await db.query("select public.seed_ip_pool($1, '10.19.0.0/27'::cidr)", [NODE]);

  // --- 1. Ohne Abo ---------------------------------------------------------
  const noSub = await createTestUser(db, "map-nosub@example.invalid");
  const subscriptionRequired = await failure(() => register(db, noSub, 1));

  // --- 2. Pi-hole ohne Add-on ---------------------------------------------
  const noAddon = await createTestUser(db, "map-noaddon@example.invalid");
  await subscribe(db, noAddon, "active");
  const addonNotBooked = await failure(() => register(db, noAddon, 2, { pihole: true }));

  // --- 3. Gerätelimit ------------------------------------------------------
  const limited = await createTestUser(db, "map-limit@example.invalid");
  await subscribe(db, limited, "active");
  await register(db, limited, 3, { limit: 1 });
  const limitReached = await failure(() => register(db, limited, 4, { limit: 1 }));

  // --- 4. Schlüssel eines anderen Kontos ----------------------------------
  const owner = await createTestUser(db, "map-owner@example.invalid");
  await subscribe(db, owner, "active");
  const ownerDevice = await register(db, owner, 5);
  const thief = await createTestUser(db, "map-thief@example.invalid");
  await subscribe(db, thief, "active");
  const keyConflict = await failure(() => register(db, thief, 5));

  // --- 5./6. Widerrufenes Gerät (Registrierung und Schlüsselwechsel) ------
  const revokedUser = await createTestUser(db, "map-revoked@example.invalid");
  await subscribe(db, revokedUser, "active");
  const revokedDevice = await register(db, revokedUser, 6);
  await db.query("select public.revoke_device($1)", [revokedDevice.device_id]);
  const revokedOnRegister = await failure(() => register(db, revokedUser, 6));
  const revokedOnRebind = await failure(() =>
    rebind(db, revokedUser, revokedDevice.device_id, 7),
  );

  // --- 7. Fremdes Gerät ----------------------------------------------------
  const stranger = await createTestUser(db, "map-stranger@example.invalid");
  await subscribe(db, stranger, "active");
  // Fremd UND widerrufen — die Besitzprüfung läuft zuerst, deshalb P0005.
  const foreignDevice = await failure(() =>
    rebind(db, stranger, revokedDevice.device_id, 8),
  );

  // --- 8. Schlüsselwechsel ohne Abo ---------------------------------------
  const lapsed = await createTestUser(db, "map-lapsed@example.invalid");
  await subscribe(db, lapsed, "active");
  const lapsedDevice = await register(db, lapsed, 9);
  await subscribe(db, lapsed, "canceled");
  const rebindWithoutSub = await failure(() =>
    rebind(db, lapsed, lapsedDevice.device_id, 10),
  );

  // --- 9. Erschöpfter Pool -------------------------------------------------
  const poolUser = await createTestUser(db, "map-pool@example.invalid");
  await subscribe(db, poolUser, "active");
  // /29 hat sieben nutzbare Host-Adressen (broadcast − network − 1).
  await db.query("select public.seed_ip_pool($1, '10.19.9.0/29'::cidr)", [FULL_NODE]);
  let granted = 0;
  let poolExhausted = null;
  for (let i = 0; i < 12; i += 1) {
    const error = await failure(() => register(db, poolUser, 100 + i, { node: FULL_NODE }));
    if (error) {
      poolExhausted = error;
      break;
    }
    granted += 1;
  }
  // `seed_ip_pool` legt broadcast − network − 1 Adressen an; eine davon bleibt
  // reserviert. Entscheidend ist, dass am Ende kein freier Platz mehr da ist —
  // nur dann beweist der nächste Aufruf wirklich die Erschöpfung.
  const pool = (
    await db.query(
      "select count(*)::int as total, count(*) filter (where state = 'free')::int as free from public.ip_pool where node_id = $1",
      [FULL_NODE],
    )
  ).rows[0];
  check(
    pool.free === 0 && granted > 0,
    `Pool vollständig belegt (${granted} von ${pool.total} Adressen vergeben, ${pool.free} frei)`,
  );

  // --- 10. Constraint-Fälle (defensiv, außerhalb der RPC) ------------------
  const duplicateKey = await failure(() =>
    db.query(
      "insert into public.devices (user_id, name, platform, public_key) values ($1, 'Doppelt', 'web', $2)",
      [owner, fakePublicKey(5)],
    ),
  );
  const missingProfile = await failure(() =>
    db.query(
      "insert into public.devices (user_id, name, platform, public_key) values (gen_random_uuid(), 'Waise', 'web', $1)",
      [fakePublicKey(11)],
    ),
  );

  // --- Vertrag: echter Fehler → erwartete Antwort --------------------------
  const cases = [
    {
      label: "ohne Abo (Registrierung)",
      expected: { sqlstate: "P0006", status: 403, code: "SUBSCRIPTION_REQUIRED", operation: "register" },
      error: subscriptionRequired,
      marker: "SUBSCRIPTION_REQUIRED",
    },
    {
      label: "Add-on nicht gebucht",
      expected: { sqlstate: "P0007", status: 403, code: "ADDON_NOT_BOOKED", operation: "register" },
      error: addonNotBooked,
      marker: "ADDON_NOT_BOOKED",
    },
    {
      label: "Gerätelimit erreicht",
      expected: { sqlstate: "P0003", status: 409, code: "DEVICE_LIMIT_REACHED", operation: "register" },
      error: limitReached,
      marker: "DEVICE_LIMIT_REACHED",
    },
    {
      label: "Public Key eines anderen Kontos",
      expected: { sqlstate: "P0004", status: 409, code: "DEVICE_EXISTS", operation: "register" },
      error: keyConflict,
      marker: "DEVICE_KEY_CONFLICT",
    },
    {
      label: "widerrufenes Gerät (Registrierung)",
      expected: { sqlstate: "P0002", status: 409, code: "DEVICE_REVOKED", operation: "register" },
      error: revokedOnRegister,
      marker: "DEVICE_REVOKED",
    },
    {
      label: "widerrufenes Gerät (Schlüsselwechsel)",
      expected: { sqlstate: "P0002", status: 409, code: "DEVICE_REVOKED", operation: "rebind" },
      error: revokedOnRebind,
      marker: "DEVICE_REVOKED",
    },
    {
      label: "fremdes Gerät",
      expected: { sqlstate: "P0005", status: 404, code: "DEVICE_NOT_FOUND", operation: "rebind" },
      error: foreignDevice,
      marker: "DEVICE_NOT_FOUND",
    },
    {
      label: "ohne Abo (Schlüsselwechsel)",
      expected: { sqlstate: "P0006", status: 403, code: "SUBSCRIPTION_REQUIRED", operation: "rebind" },
      error: rebindWithoutSub,
      marker: "SUBSCRIPTION_REQUIRED",
    },
    {
      label: "erschöpfter Pool",
      expected: { sqlstate: "P0001", status: 503, code: "POOL_EXHAUSTED", operation: "register" },
      error: poolExhausted,
      marker: "IP_POOL_EXHAUSTED",
    },
    {
      label: "Unique-Verletzung (23505)",
      expected: { sqlstate: "23505", status: 409, code: "DEVICE_EXISTS", operation: "rebind" },
      error: duplicateKey,
      marker: null,
    },
    {
      label: "fehlendes Profil (23503)",
      expected: { sqlstate: "23503", status: 409, code: "PROFILE_MISSING", operation: "register" },
      error: missingProfile,
      marker: null,
    },
  ];

  for (const testCase of cases) {
    const { label, expected, error, marker } = testCase;

    check(
      error !== null && error.code === expected.sqlstate,
      `${label}: Datenbank meldet ${expected.sqlstate} (${error?.code ?? "kein Fehler"})`,
    );
    if (marker) {
      check(
        typeof error?.message === "string" && error.message.includes(marker),
        `${label}: Marker ${marker} steht im Fehlertext`,
      );
    }

    const mapped = describeDeviceFailure(
      { message: error?.message, code: error?.code },
      expected.operation,
    );

    check(
      mapped.status === expected.status && mapped.code === expected.code,
      `${label}: abgebildet auf ${expected.status} ${expected.code} (${mapped.status} ${mapped.code})`,
    );
    check(
      !/P000\d|235\d\d/.test(mapped.message) && mapped.message !== error?.message,
      `${label}: Antwort verrät weder SQLSTATE noch DB-Text`,
    );
  }

  // --- Vollständigkeit: kein Marker ohne Abbildung -------------------------
  const files = (await readdir(path.join(root, "supabase/migrations"))).filter((name) =>
    name.endsWith(".sql"),
  );
  const found = new Set();
  for (const file of files) {
    const sql = await readFile(path.join(root, "supabase/migrations", file), "utf8");
    for (const match of sql.matchAll(/raise exception '([A-Z_]+)/g)) found.add(match[1]);
  }

  const covered = new Set(cases.map((c) => c.marker).filter(Boolean));
  const unhandled = [...found].filter((m) => !covered.has(m) && !KNOWN_UNMAPPED.has(m));
  check(
    unhandled.length === 0,
    `jeder raise exception ist abgebildet (${found.size} Marker, ${unhandled.length} offen${
      unhandled.length > 0 ? `: ${unhandled.join(", ")}` : ""
    })`,
  );
  check(covered.size === found.size - KNOWN_UNMAPPED.size, "Abdeckung passt zur Marker-Liste");

  await db.end();
  finish("Fehlerabbildung");
}

main().catch((error) => {
  console.error("Mapping-Test abgebrochen:", error.message);
  process.exit(1);
});
