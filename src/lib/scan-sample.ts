/**
 * scan-sample.ts — the pre-loaded "live example" for the public /scan page.
 *
 * This is Rejuv Skin Spa's REAL Acuity export run through the exact
 * `parseAppointmentCsv` → `analyzeScannedAppointments` pipeline (verified
 * against the real file: 5,754 appointments, 1,015 loss events, 770 refilled
 * / 245 truly empty). We bake only the AGGREGATE receipt — counts, dollars,
 * by-bucket breakdowns. ZERO patient PII is shipped (no names, no contacts);
 * the raw CSV never leaves the owner's machine.
 *
 * We own it: the /scan page shows this as "our own spa, Rejuv" — dogfooding
 * is the most honest demo. Re-generate with `tmp-sample-receipt.ts` if the
 * source export changes.
 */

import type { ParsedAppointmentFile } from "@/lib/appointment-csv";
import type { ScanReceipt } from "@/lib/scan-analysis";

export const SAMPLE_FILE_LABEL = "Rejuv Skin Spa — Acuity export";

export const SAMPLE_RECEIPT: ScanReceipt = {
  totalAppointments: 5754,
  dateRangeStart: "2024-01-03",
  dateRangeEnd: "2026-05-29",
  monthsCovered: 29.2,
  statusBreakdown: {
    scheduled: 0,
    confirmed: 0,
    cancelled: 998,
    no_show: 17,
    showed: 4099,
    rescheduled: 640,
  },
  topServices: [
    { name: "Tox w/ Karen", count: 4132 },
    { name: "Tox + Filler w/ Karen", count: 576 },
    { name: "Filler w/ Karen", count: 360 },
    { name: "RF Micro Face", count: 106 },
    { name: "Sculptra", count: 105 },
  ],
  uniqueProviders: 3,
  byDayOfWeek: [
    { label: "Sun", cancelledCount: 0, refilledCount: 0, emptyCount: 0, emptyLeakUsd: 0 },
    { label: "Mon", cancelledCount: 29, refilledCount: 18, emptyCount: 11, emptyLeakUsd: 2750 },
    { label: "Tue", cancelledCount: 248, refilledCount: 214, emptyCount: 34, emptyLeakUsd: 8500 },
    { label: "Wed", cancelledCount: 247, refilledCount: 165, emptyCount: 82, emptyLeakUsd: 20500 },
    { label: "Thu", cancelledCount: 246, refilledCount: 201, emptyCount: 45, emptyLeakUsd: 11250 },
    { label: "Fri", cancelledCount: 210, refilledCount: 144, emptyCount: 66, emptyLeakUsd: 16500 },
    { label: "Sat", cancelledCount: 35, refilledCount: 28, emptyCount: 7, emptyLeakUsd: 1750 },
  ],
  byProvider: [
    { label: "Rejuv Skin Spa", cancelledCount: 892, refilledCount: 757, emptyCount: 135, emptyLeakUsd: 33750 },
    { label: "Rejuv — Michelle", cancelledCount: 91, refilledCount: 7, emptyCount: 84, emptyLeakUsd: 21000 },
    { label: "Lisa", cancelledCount: 32, refilledCount: 6, emptyCount: 26, emptyLeakUsd: 6500 },
  ],
  byService: [
    { label: "Tox w/ Karen", cancelledCount: 651, refilledCount: 565, emptyCount: 86, emptyLeakUsd: 21500 },
    { label: "RF Micro Face", cancelledCount: 29, refilledCount: 4, emptyCount: 25, emptyLeakUsd: 6250 },
    { label: "RF Micro Face+Neck", cancelledCount: 23, refilledCount: 2, emptyCount: 21, emptyLeakUsd: 5250 },
    { label: "Tox + Filler w/ Karen", cancelledCount: 93, refilledCount: 75, emptyCount: 18, emptyLeakUsd: 4500 },
    { label: "Filler w/ Karen", cancelledCount: 88, refilledCount: 75, emptyCount: 13, emptyLeakUsd: 3250 },
    { label: "RF Micro Neck", cancelledCount: 12, refilledCount: 2, emptyCount: 10, emptyLeakUsd: 2500 },
    { label: "Sculptra", cancelledCount: 27, refilledCount: 17, emptyCount: 10, emptyLeakUsd: 2500 },
    { label: "Consult", cancelledCount: 13, refilledCount: 4, emptyCount: 9, emptyLeakUsd: 2250 },
    { label: "Thulium Laser Face", cancelledCount: 10, refilledCount: 2, emptyCount: 8, emptyLeakUsd: 2000 },
    { label: "CoolSculpting", cancelledCount: 7, refilledCount: 0, emptyCount: 7, emptyLeakUsd: 1750 },
  ],
  noShowCount: 17,
  cancelledCount: 998,
  totalLossEvents: 1015,
  refilledSlotCount: 770,
  emptySlotCount: 245,
  grossMonthlyLeakUsd: 8690,
  monthlyManualSavedUsd: 6592,
  monthlyLeakUsd: 2098,
  monthlyRecoveryFloorUsd: 944,
  monthlyRecoveryCeilingUsd: 1154,
  annualRecoveryFloorUsd: 11328,
  annualRecoveryCeilingUsd: 13848,
  hasUsableStatusData: true,
  insufficientDataReason: null,
};

/** Minimal parsed-file stub so the sample satisfies ScanState; the receipt is
 *  already computed, so the appointment list is intentionally empty. */
export const SAMPLE_PARSED: ParsedAppointmentFile = {
  dialect: "csv-acuity",
  dialectConfidence: "high",
  appointments: [],
  warnings: [],
  headers: [
    "Start Time", "End Time", "Type", "Calendar", "Appointment Price",
    "Date Scheduled", "Date Rescheduled", "Canceled", "Date Canceled",
  ],
};
