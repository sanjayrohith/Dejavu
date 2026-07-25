#!/usr/bin/env bun
/** One-shot restart of the local agent's Dejavu store to resolve its handoff. */
import { Dejavu } from "../../src/index.ts";

const db = process.env.EXP16_LOCAL_DB;
const id = process.env.EXP16_HANDOFF_ID;
const query = process.env.EXP16_QUERY ?? "";
if (!db || !id) throw new Error("missing EXP16_LOCAL_DB or EXP16_HANDOFF_ID");
const dejavu = new Dejavu({ path: db, noChainRollup: true, recordRecallTraces: false });
const resolved = dejavu.resolveHandoff(id, "completed");
const recalled = dejavu.recall(query);
console.log(JSON.stringify({
  pid: process.pid,
  scope: dejavu.scope,
  resolved,
  activeHandoff: recalled.activeHandoff,
  hitIds: recalled.hits.map((hit) => hit.slip.id),
}));
dejavu.close();
