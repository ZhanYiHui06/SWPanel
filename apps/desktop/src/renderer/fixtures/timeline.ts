/**
 * Fixed ISO-8601 timestamps used by every deterministic mock fixture.
 *
 * All scenario seeds derive from these constants so that building the same
 * scenario twice always yields byte-identical data.
 *
 * Source-of-truth notes:
 * - The `.design` prototype and `ui-content-fixtures.md` contained fixture
 *   contradictions (for example the same Run shown both "running" and
 *   "completed", M02 without a completed source Run, an "approved" M01 with a
 *   rejection feedback record, and M02's rejection timestamp predating its own
 *   source Run). The canonical dataset resolves these without changing the
 *   visual story: R01-R05 keep their documented statuses and M01/M02/M03 keep
 *   their documented review results.
 * - The visual cost reports Q01/Q02 carried the prototype's "08-06 10:42" /
 *   "08-07 16:18" display dates, which predate both the V3 upload (08-10) and
 *   M01's approval (08-09). A Cost Report can only depend on the
 *   then-qualified approved / current model, so Q01/Q02 now fall inside M01's
 *   tenure as the current formal model (after M01's approval and before M03's
 *   approval). The documented Q01 < Q02 < Q03 order and the M01/M01/M03 model
 *   references are preserved.
 * - Resolution: M01 keeps its APPROVED "历史正式模型" history and its
 *   contradictory rejection feedback is dropped. The rejected M02 is produced
 *   by a background Run R06 (created after R05, per the doc's explicit
 *   allowance "可在设计时按需要调整来源"), and M02's rejection timestamp is
 *   moved after its source Run. R06 is the 6th run on the revision and appears
 *   as a historical run in the repository; the five documented runs remain the
 *   featured timeline.
 * - V3's upload was moved before the first V3 Run R01 (08-09 18:03). The
 *   prototype showed R01/R02 on "昨天" (08-09) while the V3 upload date sat on
 *   08-10 14:44, which made R01/R02 run before their revision existed. The
 *   canonical chain `revision created <= run created <= run completed <= model
 *   generated <= review <= report` requires every Run to start after its
 *   revision, so V3 is now uploaded at 08-09 17:00 while the documented R01-R05
 *   display times (昨天 18:03 / 昨天 21:16 / 今天 18:42 / 今天 20:18 / 今天
 *   22:31) are preserved unchanged.
 * - The main drawing's Clarification Run is R04 (open or answered per
 *   scenario); the secondary drawing D keeps the always-open Clarification R02
 *   used by the `clarification-open` scenario.
 */
export const TIME = {
  // Drawing / revision
  mainCreated: "2026-08-06T08:00:00.000Z",
  v1Uploaded: "2026-08-06T08:00:00.000Z",
  v2Uploaded: "2026-08-08T09:00:00.000Z",
  // Must precede every Run on V3 (R01 created 08-09 18:03). See the note above.
  v3Uploaded: "2026-08-09T17:00:00.000Z",

  // Main drawing V3 runs
  r01Created: "2026-08-09T18:03:00.000Z",
  r01Completed: "2026-08-09T18:41:00.000Z",
  m01Approved: "2026-08-09T19:06:00.000Z",

  r02Created: "2026-08-09T21:16:00.000Z",
  r02Failed: "2026-08-09T22:05:00.000Z",

  r03Created: "2026-08-10T18:42:00.000Z",
  r03Cancelled: "2026-08-10T18:55:00.000Z",

  r04Created: "2026-08-10T20:18:00.000Z",
  r04Clarified: "2026-08-10T20:40:00.000Z",
  r04Answered: "2026-08-10T21:10:00.000Z",

  r05Created: "2026-08-10T22:31:00.000Z",
  r05Completed: "2026-08-10T22:44:00.000Z",
  r05Cancelled: "2026-08-10T22:41:00.000Z",
  r05Failed: "2026-08-10T22:40:00.000Z",
  m03Approved: "2026-08-10T22:50:00.000Z",
  m03Rejected: "2026-08-10T22:52:00.000Z",

  // Background Run R06 that produced the rejected M02 (fixes the M02 source
  // contradiction; rejection time moved after its source Run).
  r06Created: "2026-08-10T22:50:00.000Z",
  r06Completed: "2026-08-10T23:10:00.000Z",
  m02Rejected: "2026-08-10T23:15:00.000Z",

  // Secondary drawings
  aR01Created: "2026-08-08T10:00:00.000Z",
  aR01Completed: "2026-08-08T10:40:00.000Z",
  aR02Created: "2026-08-09T08:00:00.000Z",
  aR02Cancelled: "2026-08-09T08:20:00.000Z",
  aR03Created: "2026-08-10T12:00:00.000Z",

  bR01Created: "2026-08-10T13:00:00.000Z",

  cR01Created: "2026-08-08T15:00:00.000Z",
  cR01Completed: "2026-08-08T15:40:00.000Z",
  // The current secondary Run starts after the main V3 completed/report history,
  // so the single-machine fixture never overlaps a RUNNING Run with later
  // completed R05/R06 work.
  cR02Created: "2026-08-10T23:30:00.000Z",

  dR01Created: "2026-08-07T11:00:00.000Z",
  dR01Completed: "2026-08-07T11:40:00.000Z",
  dR02Created: "2026-08-10T11:32:00.000Z",
  dR02Clarified: "2026-08-10T11:40:00.000Z",

  // Cost data / reports
  costDataUpdated: "2026-08-10T08:00:00.000Z",
  // The 08-10 08:00 Cost Data update postdates Q01/Q02 (08-09). Q01/Q02 freeze
  // the historical version of the cost basis (last touched before the update),
  // so a report captured at 08-09 never references cost items stamped 08-10.
  costDataUpdatedHistorical: "2026-08-08T09:00:00.000Z",
  materialEffectiveFrom: "2026-08-01T00:00:00.000Z",
  // Q01/Q02 reference M01 (the V3 current formal model until M03's approval).
  // They are placed inside M01's tenure: after M01's approval (08-09 19:06) and
  // before M03's approval (08-10 22:50), preserving the documented Q01<Q02<Q03
  // order. The prototype's "08-06"/"08-07" display dates predate the V3 upload
  // and were dropped because a report can only depend on the then-qualified
  // approved/current model.
  q01Created: "2026-08-09T19:30:00.000Z",
  q02Created: "2026-08-09T20:00:00.000Z",
  q03Created: "2026-08-10T23:21:00.000Z"
} as const;
