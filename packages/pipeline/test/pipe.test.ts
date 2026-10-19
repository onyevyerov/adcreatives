import { describe, expect, it } from "vitest";
import { emptyPipe, PipeState } from "../src/pipe.ts";

describe("PipeState: провайдери звуку", () => {
  it("старий pipeline.json без провайдерів — elevenlabs/elevenlabs", () => {
    const { musicProvider: _m, sfxProvider: _s, ...old } = emptyPipe();
    expect(PipeState.parse(JSON.parse(JSON.stringify(old)))).toMatchObject({
      musicProvider: "elevenlabs",
      sfxProvider: "elevenlabs",
    });
    expect(emptyPipe()).toMatchObject({ musicProvider: "elevenlabs", sfxProvider: "elevenlabs" });
  });

  it("провайдери ревізії зберігаються; невідомий — помилка", () => {
    const pipe = PipeState.parse({ ...emptyPipe(), musicProvider: "epidemic" });
    expect(pipe).toMatchObject({ musicProvider: "epidemic", sfxProvider: "elevenlabs" });
    expect(() => PipeState.parse({ ...emptyPipe(), sfxProvider: "suno" })).toThrow();
  });
});
