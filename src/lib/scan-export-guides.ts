import type { AppointmentDialect } from "@/lib/appointment-csv";

export type ExportGuide = {
  steps: string[];
  // Optional deep link the spa owner can click to land on their scheduler's
  // export screen directly. Only set when the URL is stable + verified.
  exportUrl?: string;
  // OAuth-live note: shown when this platform also has a one-click OAuth
  // path elsewhere in Refill (currently only Acuity). Surfaces the "you
  // could skip the CSV entirely" affordance without making it the headline
  // — per the trojan-horse posture, OAuth lives POST-value, not pre-value.
  oauthLiveNote?: string;
};

// Confirmed export steps for the highest-traffic schedulers. Per
// feedback_validate_against_real_exports: only ship instructions we can
// verify; everything else falls through to GENERIC_FALLBACK. As Grasshopper
// (or a real spa owner) confirms additional paths, append entries here.
export const EXPORT_GUIDES: Partial<Record<AppointmentDialect, ExportGuide>> = {
  "csv-acuity": {
    steps: [
      "Sign in to your Acuity scheduling account.",
      "Open the left-side menu → Reports.",
      "Choose Appointments → set the date range you want (last 6-12 months works best).",
      "Click Export → CSV. The download lands in your Downloads folder.",
    ],
    exportUrl: "https://app.acuityscheduling.com/reports.php",
    oauthLiveNote:
      "Acuity also supports one-click live mode — after you see your math below, you can connect it directly without re-exporting.",
  },
  "csv-mindbody": {
    steps: [
      "Sign in to Mindbody Business mode (mindbodyonline.com).",
      "Go to Reports → Appointment Reports → All Appointments.",
      "Set the date range (last 6-12 months recommended).",
      "Click Export → CSV at the top right of the report.",
    ],
  },
  "csv-boulevard": {
    steps: [
      "Sign in to Boulevard (dashboard.joinblvd.com).",
      "Go to Reports → Appointments.",
      "Set the date range and any filters (leave provider filter on All).",
      "Click the download / export icon → CSV.",
    ],
  },
  "csv-janeapp": {
    steps: [
      "Sign in to Jane (yourclinic.janeapp.com → Admin).",
      "Open Reports → Appointments (under the Schedule section).",
      "Set the date range — Jane lets you go back as far as you've been on the platform.",
      "Click Export to CSV.",
    ],
  },
  "csv-square": {
    steps: [
      "Sign in to Square Appointments (squareup.com/appointments).",
      "Open Reporting → Appointments.",
      "Set the date range.",
      "Click Export → CSV.",
    ],
  },
};

export const GENERIC_FALLBACK: ExportGuide = {
  steps: [
    "Sign in to your scheduler's admin area.",
    "Look for Reports → Appointments (or Bookings).",
    "Set a 6-12 month date range — more history = better math.",
    "Find an Export, Download, or CSV button — most schedulers put it at the top right of the report.",
    "Save the .csv to your Downloads folder, then drop it on this page.",
  ],
};

export function guideFor(dialect: AppointmentDialect): ExportGuide {
  return EXPORT_GUIDES[dialect] ?? GENERIC_FALLBACK;
}
