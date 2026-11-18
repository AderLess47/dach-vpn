"use client";

import { useState } from "react";
import { AuthGate } from "./auth-gate";
import { DeviceList } from "./device-list";
import { KeyGenPanel } from "./key-gen-panel";
import { SubscriptionCard } from "./subscription-card";

export function DeviceConsole() {
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <AuthGate>
      {(session) => (
        <div className="flex flex-col gap-6">
          <SubscriptionCard accessToken={session?.access_token ?? null} />
          <KeyGenPanel
            accessToken={session?.access_token ?? null}
            onRegistered={() => setReloadKey((value) => value + 1)}
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
