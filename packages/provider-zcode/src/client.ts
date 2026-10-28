import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { ZcodeSettings } from "./settings.ts";

export const zcodeClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("zcode"),
  label: "ZCode",
  settingsSchema: ZcodeSettings,
  featured: false,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#1A7AFF", dark: "#6BA6FF" },
    paths: [
      {
        d: "M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v2A1.5 1.5 0 0 1 18.5 9H9.8l8.7 8.2A1.5 1.5 0 0 1 17.4 20h-13A1.5 1.5 0 0 1 4 18.5v-2A1.5 1.5 0 0 1 5.5 15h8.7L5.5 6.8A1.5 1.5 0 0 1 4 5.5Z",
      },
    ],
  },
});
