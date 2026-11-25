import { describe, expect, it } from "vitest";
import {
  KEEPALIVE_AFTER_DAYS,
  clampTimeout,
  decodeCapped,
  keepaliveDue,
  ptyControl,
  ptyCwd,
  ptySize,
  sameSecret,
  validKey,
} from "../src/schedule";

const DAY = 86_400_000;
const utc = (s: string) => Date.parse(s);

describe("keepaliveDue", () => {
  it("is 09:00 UTC on day 25 when the snapshot was taken before 09:00", () => {
    expect(new Date(keepaliveDue(utc("2026-11-01T03:00:00Z"))).toISOString()).toBe("2026-11-26T09:00:00.000Z");
  });

  it("moves to the next day when day 25 is already past 09:00", () => {
    expect(new Date(keepaliveDue(utc("2026-11-01T15:30:00Z"))).toISOString()).toBe("2026-11-27T09:00:00.000Z");
  });

  it("keeps 09:00 exactly", () => {
    expect(new Date(keepaliveDue(utc("2026-11-01T09:00:00Z"))).toISOString()).toBe("2026-11-26T09:00:00.000Z");
  });

  it("is always after day 25 and before the 30-day expiry", () => {
    for (let h = 0; h < 48; h++) {
      const anchor = utc("2026-12-30T00:00:00Z") + h * 1_800_000;
      const due = keepaliveDue(anchor);
      expect(due).toBeGreaterThanOrEqual(anchor + KEEPALIVE_AFTER_DAYS * DAY);
      expect(due).toBeLessThan(anchor + 30 * DAY);
      expect(new Date(due).getUTCHours()).toBe(9);
    }
  });
});

describe("request checks", () => {
  it("accepts the keys the gateway and the plugin make, and nothing else", () => {
    expect(validKey("af-0a1b2c3d-4e5f-6789-abcd-ef0123456789")).toBe(true);
    expect(validKey("default--task_1")).toBe(true);
    expect(validKey(null)).toBe(false);
    expect(validKey("")).toBe(false);
    expect(validKey("a/b")).toBe(false);
    expect(validKey("x".repeat(65))).toBe(false);
  });

  it("clamps timeouts", () => {
    expect(clampTimeout(undefined)).toBe(120);
    expect(clampTimeout("30")).toBe(30);
    expect(clampTimeout(-1)).toBe(120);
    expect(clampTimeout(99_999)).toBe(3600);
  });

  it("cuts long output and says so", () => {
    const big = new TextEncoder().encode("a".repeat(20)).buffer as ArrayBuffer;
    expect(decodeCapped(big, 100)).toBe("a".repeat(20));
    const cut = decodeCapped(big, 5);
    expect(cut.startsWith("aaaaa\n[cf-dev-sandbox: output cut at 5 bytes of 20]")).toBe(true);
  });

  it("compares tokens", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abd")).toBe(false);
    expect(sameSecret("abc", "abcd")).toBe(false);
  });
});

describe("interactive shell", () => {
  it("takes a sane size and falls back to 80x24", () => {
    expect(ptySize("132", "43")).toEqual({ cols: 132, rows: 43 });
    expect(ptySize(null, "x")).toEqual({ cols: 80, rows: 24 });
    expect(ptySize(0, -5)).toEqual({ cols: 80, rows: 24 });
    expect(ptySize(99999, 2)).toEqual({ cols: 1000, rows: 2 });
  });

  it("starts in an absolute folder, else the workspace", () => {
    expect(ptyCwd("/workspace/app")).toBe("/workspace/app");
    expect(ptyCwd(null)).toBe("/workspace");
    expect(ptyCwd("app")).toBe("/workspace");
    expect(ptyCwd("/a\0b")).toBe("/workspace");
    expect(ptyCwd("/" + "a".repeat(5000))).toBe("/workspace");
  });

  it("reads a resize and ignores any other text frame", () => {
    expect(ptyControl('{"resize":[120,40]}')).toEqual({ resize: { cols: 120, rows: 40 } });
    expect(ptyControl('{"resize":[120]}')).toBeNull();
    expect(ptyControl("ls -la\n")).toBeNull();
    expect(ptyControl('{"exit":0}')).toBeNull();
  });
});
