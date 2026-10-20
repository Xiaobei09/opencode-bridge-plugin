import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/auto-continue.ts", import.meta.url), "utf8");

describe("r2236 completed dead-turn resume", () => {
  it("declares the version and treats completed no-text/no-tool as workedAnyway", () => {
    expect(src).toContain('const VERSION = "r2236-completed-dead-turn-resume"');
    expect(src).toMatch(/const completedDead = completedTs > 0 && !hasRealToolWork\(msg\) && len === 0/);
    expect(src).toMatch(/const workedAnyway = hasNonTextWork\(msg\) \|\| completedDead/);
  });

  it("has a bounded completed-dead resume path and a GIVEUP after x3", () => {
    expect(src).toMatch(/completedDeadTurn[\s\S]{0,1600}?n >= 3[\s\S]{0,500}?GIVEUP\(completed-dead x/);
    expect(src).toContain("completed dead-turn x${n} -> resume loop");
  });
});
