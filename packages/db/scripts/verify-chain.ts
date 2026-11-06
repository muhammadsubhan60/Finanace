/** Nightly integrity check: recompute the journal hash chain. Also run by the worker. */
import { closeDb, verifyJournalChain } from "../src";

verifyJournalChain()
  .then((r) => {
    console.log(r.ok ? `Journal chain OK (${r.count} entries)` : `CHAIN BROKEN at seq ${r.brokenAtSeq}`);
    if (!r.ok) process.exitCode = 2;
  })
  .finally(closeDb);
