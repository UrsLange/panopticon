import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { config } from "../server/config.js";
import { refinementLog } from "../server/refinement-log.js";

vi.mock("../server/config.js", () => ({ config: { dataDir: "" } }));
afterEach(() => vi.restoreAllMocks());

it("appends private DEBUG records to a file without writing to the console", () => {
  config.dataDir = join(mkdtempSync(join(tmpdir(), "pa-refinement-log-")), "data");
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const records = [
    { event: "capture_refinement.request_started", runId: "run", request: 1 },
    { event: "capture_refinement.finished", runId: "run", status: "completed" },
  ];
  for (const record of records) refinementLog.debug(record);
  const path = join(config.dataDir, "refinement.debug.jsonl");
  expect(
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual(records.map((record) => ({ ...record, level: "debug" })));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(info).not.toHaveBeenCalled();
  expect(debug).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

it("reports a file failure without interrupting refinement or leaking the record", () => {
  config.dataDir = join(mkdtempSync(join(tmpdir(), "pa-refinement-log-")), "not-a-directory");
  writeFileSync(config.dataDir, "occupied");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => refinementLog.debug({ event: "private record" })).not.toThrow();
  expect(error).toHaveBeenCalledWith("Could not write refinement debug log.");
});
