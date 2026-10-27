import { describe, expect, it } from "vitest";
import { applyEdits, fileOutputFormat, parseFixOutput, patchOutputFormat } from "../src/patch.ts";

const edits = (file: string, body: string) => `<edits file="${file}">\n${body}\n</edits>`;
const edit = (o: string, n: string) => `<edit>\n<old>\n${o}\n</old>\n<new>\n${n}\n</new>\n</edit>`;

describe("parseFixOutput", () => {
  it("розбирає кілька правок у порядку відповіді", () => {
    const text = `Ось:\n${edits("s1.tsx", `${edit("const a = 1;", "const a = 2;")}\n${edit("  foo();\n  bar();", "  baz();")}`)}`;
    expect(parseFixOutput(text, "s1")).toEqual({
      kind: "edits",
      edits: [
        { old: "const a = 1;", new: "const a = 2;" },
        { old: "  foo();\n  bar();", new: "  baz();" },
      ],
    });
  });

  it("знімає рівно один перший і один останній перенос рядка", () => {
    const text = '<edits file="s1.tsx"><edit><old>\n\nx\n\n</old><new>\n\n</new></edit></edits>';
    expect(parseFixOutput(text, "s1")).toEqual({ kind: "edits", edits: [{ old: "\nx\n", new: "" }] });
  });

  it("порожній new — видалення", () => {
    const r = parseFixOutput(edits("s1.tsx", "<edit>\n<old>\nx\n</old>\n<new>\n</new>\n</edit>"), "s1");
    expect(r).toEqual({ kind: "edits", edits: [{ old: "x", new: "" }] });
  });

  it("нормалізує CRLF у відповіді", () => {
    const text = edits("s1.tsx", edit("a\nb", "c")).replace(/\n/g, "\r\n");
    expect(parseFixOutput(text, "s1")).toEqual({ kind: "edits", edits: [{ old: "a\nb", new: "c" }] });
  });

  it("повний <file> замість <edits> → file", () => {
    const text = '<file name="s1.tsx">\nexport default function S1() {}\n</file>';
    expect(parseFixOutput(text, "s1")).toEqual({ kind: "file", code: "export default function S1() {}\n" });
  });

  it("сміття → none", () => {
    expect(parseFixOutput("Вибачте, не можу.", "s1")).toEqual({ kind: "none" });
    expect(parseFixOutput("", "s1")).toEqual({ kind: "none" });
  });

  it("<edits> без жодної правки або з <edit> без <new> → none", () => {
    expect(parseFixOutput('<edits file="s1.tsx">\n</edits>', "s1")).toEqual({ kind: "none" });
    expect(parseFixOutput(edits("s1.tsx", "<edit>\n<old>\nx\n</old>\n</edit>"), "s1")).toEqual({
      kind: "none",
    });
  });

  it("чужий file=sX.tsx → none", () => {
    expect(parseFixOutput(edits("s2.tsx", edit("a", "b")), "s1")).toEqual({ kind: "none" });
    expect(parseFixOutput('<file name="s2.tsx">\ncode\n</file>', "s1")).toEqual({ kind: "none" });
  });

  it("старий шлях scenes/s1.tsx приймається", () => {
    expect(parseFixOutput(edits("scenes/s1.tsx", edit("a", "b")), "s1").kind).toBe("edits");
  });

  it("якщо є і <edits>, і <file> — перемагають <edits>", () => {
    const text = `${edits("s1.tsx", edit("a", "b"))}\n<file name="s1.tsx">\ncode\n</file>`;
    expect(parseFixOutput(text, "s1").kind).toBe("edits");
  });
});

describe("applyEdits", () => {
  const code = "line1\nline2\nline3\n";

  it("застосовує правки по черзі, наступна бачить результат попередньої", () => {
    const r = applyEdits(code, [
      { old: "line2", new: "LINE2" },
      { old: "LINE2\nline3", new: "merged" },
    ]);
    expect(r).toEqual({ ok: true, code: "line1\nmerged\n" });
  });

  it("порожній new видаляє фрагмент", () => {
    expect(applyEdits(code, [{ old: "line2\n", new: "" }])).toEqual({ ok: true, code: "line1\nline3\n" });
  });

  it("old, якого немає → ok:false з editIndex", () => {
    const r = applyEdits(code, [
      { old: "line1", new: "x" },
      { old: "nope", new: "y" },
    ]);
    expect(r).toMatchObject({ ok: false, editIndex: 1 });
  });

  it("old, що трапляється двічі → ok:false з editIndex", () => {
    const r = applyEdits("a\nb\na\n", [{ old: "a", new: "c" }]);
    expect(r).toMatchObject({ ok: false, editIndex: 0 });
  });

  it("збіги, що перекриваються, теж вважаються повтором", () => {
    expect(applyEdits("aaa", [{ old: "aa", new: "b" }])).toMatchObject({ ok: false, editIndex: 0 });
  });

  it("порожній old → ok:false", () => {
    expect(applyEdits(code, [{ old: "", new: "x" }])).toMatchObject({ ok: false, editIndex: 0 });
  });

  it("CRLF у коді та в правках нормалізується до LF", () => {
    const r = applyEdits("a\r\nb\r\nc\r\n", [{ old: "a\r\nb", new: "x\r\ny" }]);
    expect(r).toEqual({ ok: true, code: "x\ny\nc\n" });
  });

  it("$-послідовності в new вставляються буквально", () => {
    expect(applyEdits("a", [{ old: "a", new: "$&$1" }])).toEqual({ ok: true, code: "$&$1" });
  });

  it("порожній список правок повертає код без змін", () => {
    expect(applyEdits(code, [])).toEqual({ ok: true, code });
  });

  it("parseFixOutput + applyEdits разом", () => {
    const parsed = parseFixOutput(edits("s1.tsx", edit("line2", "two")), "s1");
    if (parsed.kind !== "edits") throw new Error("очікувались edits");
    expect(applyEdits(code, parsed.edits)).toEqual({ ok: true, code: "line1\ntwo\nline3\n" });
  });
});

describe("тексти <output_format>", () => {
  it("fileOutputFormat — дослівний рядок code-fix.md + вимога повного коду", () => {
    const t = fileOutputFormat("s3");
    expect(t).toContain(
      'Only one block `<file name="sN.tsx">…the full repaired code…</file>` (sN is the scene id from the message), with no markdown fences and no explanations.',
    );
    expect(t).toContain('Repair scene s3 and return its full code in `<file name="s3.tsx">`.');
  });

  it("patchOutputFormat — формат <edits>, правила old і повернення повного файлу", () => {
    const t = patchOutputFormat("s3");
    expect(t).toContain('<edits file="s3.tsx">');
    expect(t).toContain("<old>");
    expect(t).toContain("<new>");
    expect(t).toMatch(/verbatim/);
    expect(t).toMatch(/never empty/);
    expect(t).toMatch(/exactly once/);
    expect(t).toContain("more than half of the file");
    expect(t).toContain('<file name="s3.tsx">');
  });
});
