import { BrandKit, type JsonPatchOp } from "@adc/shared";
import { fixtureBrandKit } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { applyOp, applyPatch, JsonPatchError, parsePointer } from "../src/jsonPatch.ts";

const op = (o: Partial<JsonPatchOp> & Pick<JsonPatchOp, "op" | "path">): JsonPatchOp => ({
  valueJson: null,
  from: null,
  ...o,
});

describe("json patch", () => {
  it("parses pointers with escapes", () => {
    expect(parsePointer("/a~1b/c~0d/0")).toEqual(["a/b", "c~d", "0"]);
    expect(() => parsePointer("a")).toThrow(JsonPatchError);
  });

  it("applies add/replace/remove/move/copy/test", () => {
    const doc = { a: [1, 2], b: { c: "x" } } as Record<string, unknown>;
    applyOp(doc as never, op({ op: "add", path: "/a/-", valueJson: "3" }));
    applyOp(doc as never, op({ op: "add", path: "/a/0", valueJson: "0" }));
    applyOp(doc as never, op({ op: "replace", path: "/b/c", valueJson: '"y"' }));
    applyOp(doc as never, op({ op: "copy", path: "/d", from: "/b" }));
    applyOp(doc as never, op({ op: "move", path: "/e", from: "/b/c" }));
    applyOp(doc as never, op({ op: "remove", path: "/a/1" }));
    applyOp(doc as never, op({ op: "test", path: "/e", valueJson: '"y"' }));
    expect(doc).toEqual({ a: [0, 2, 3], b: {}, d: { c: "y" }, e: "y" });
    expect(() => applyOp(doc as never, op({ op: "test", path: "/e", valueJson: '"z"' }))).toThrow();
    expect(() => applyOp(doc as never, op({ op: "replace", path: "/nope", valueJson: "1" }))).toThrow();
    expect(() => applyOp(doc as never, op({ op: "remove", path: "" }))).toThrow();
  });

  it("treats non-JSON valueJson as a plain string", () => {
    const doc = { c: "x" };
    applyOp(doc as never, op({ op: "replace", path: "/c", valueJson: "#FF0000" }));
    expect(doc.c).toBe("#FF0000");
  });

  it("skips ops that fail or break the schema, applies the rest", () => {
    const accept = (d: unknown) => (BrandKit.safeParse(d).success ? null : "schema");
    const res = applyPatch(
      fixtureBrandKit,
      [
        op({ op: "replace", path: "/palette/accent", valueJson: '"#1F6B3A"' }),
        op({ op: "replace", path: "/palette/primary", valueJson: '"green"' }),
        op({ op: "remove", path: "/offerings/7" }),
        op({ op: "add", path: "/usps/-", valueJson: '"Власна пекарня"' }),
      ],
      accept,
    );
    expect(res.applied).toHaveLength(2);
    expect(res.skipped.map((s) => s.reason)).toEqual(["schema", expect.stringMatching(/індекс/)]);
    expect(res.doc.palette.accent).toBe("#1F6B3A");
    expect(res.doc.palette.primary).toBe(fixtureBrandKit.palette.primary);
    expect(res.doc.usps).toContain("Власна пекарня");
    // Вхід не мутується.
    expect(fixtureBrandKit.palette.accent).toBe("#E85D2A");
  });
});
