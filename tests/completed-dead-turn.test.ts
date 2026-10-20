import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/auto-continue.ts", import.meta.url), "utf8");

describe("r2237 stale generation + completed dead-turn resume", () => {
  it("declares the version and treats completed no-text/no-tool as workedAnyway", () => {
    expect(src).toContain('const VERSION = "r2237-stale-generation-lease-guard"');
    expect(src).toMatch(/const completedDead = completedTs > 0 && !hasRealToolWork\(msg\) && len === 0/);
    expect(src).toMatch(/const workedAnyway = hasNonTextWork\(msg\) \|\| completedDead/);
  });

  it("has a bounded completed-dead resume path and a GIVEUP after x3", () => {
    expect(src).toMatch(/completedDeadTurn[\s\S]{0,1600}?n >= 3[\s\S]{0,500}?GIVEUP\(completed-dead x/);
    expect(src).toContain("completed dead-turn x${n} -> resume loop");
  });

  it("guards stale generations before the owner lease and never lets an older generation overwrite it", () => {
    const iEval = src.indexOf("const evaluate = async (sessionID: string) => {");
    const iGuard = src.indexOf("AC_GEN_KEY] !== myGenAc", iEval);
    const iOwner = src.indexOf("AC_OWNER_PATH", iEval);
    expect(iEval).toBeGreaterThanOrEqual(0);
    expect(iGuard).toBeGreaterThan(iEval);
    expect(iOwner).toBeGreaterThan(iGuard);
    expect(src).toMatch(/const prevGen = Number\(j\?\.ac\?\.gen \?\? 0\)[\s\S]{0,800}?if \(Number\.isFinite\(prevGen\) && prevGen > myGenAc\) return[\s\S]{0,800}?gen: myGenAc/);
  });
});
