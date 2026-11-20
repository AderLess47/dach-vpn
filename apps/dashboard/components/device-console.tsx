"use client";

import { useState } from "react";
import type { Brand } from "@dachvpn/shared";
import { AuthGate } from "./auth-gate";
import { DeviceList } from "./device-list";
import { KeyGenPanel } from "./key-gen-panel";
import { SubscriptionCard } from "./subscription-card";

export function DeviceConsole({ brand }: { brand: Brand }) {
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <AuthGate>
      {(session) => (
        <div className="flex flex-col gap-6">
          <SubscriptionCard accessToken={session?.access_token ?? null} />
          <KeyGenPanel
            accessToken={session?.access_token ?? null}
            onRegistered={() => setReloadKey((value) => value + 1)}
            brand={brand}
          />
          <DeviceList
            accessToken={session?.access_token ?? null}
            reloadKey={reloadKey}
          />
        </div>
      )}
    </AuthGate>
  );
}
