import { pruneFontInfo } from "@adc/motion-kit";
import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import { getInfo as interInfo } from "@remotion/google-fonts/Inter";
import { getInfo as montserratInfo } from "@remotion/google-fonts/Montserrat";
import { Composition } from "remotion";
import { calculateMainMetadata, calculatePreviewMetadata, Main, ScenePreview } from "./compositions.tsx";
import type { MainInput, ScenePreviewInput } from "./host-props.ts";

// Дефолтні пропси — лише для Studio (кав'ярня «Зерно» з фікстур). Рендер завжди передає inputProps.
const studioFonts = [
  pruneFontInfo(montserratInfo(), fixtureBrandKit.typography.heading.weights),
  pruneFontInfo(interInfo(), fixtureBrandKit.typography.body.weights),
];

const mainDefaults: MainInput = {
  brand: fixtureBrandKit,
  storyboard: fixtureStoryboard,
  format: "vertical",
  assets: {},
  audio: { music: null, sfx: [], totalFrames: 450 },
  templateScenes: [],
  qa: false,
  fonts: studioFonts,
};

const previewDefaults: ScenePreviewInput = {
  brand: fixtureBrandKit,
  storyboard: fixtureStoryboard,
  sceneId: "s1",
  format: "vertical",
  assets: {},
  useTemplate: false,
  qa: false,
  fonts: studioFonts,
};

export function RemotionRoot() {
  return (
    <>
      <Composition
        id="Main"
        component={Main}
        defaultProps={mainDefaults}
        calculateMetadata={calculateMainMetadata}
        fps={30}
        width={1080}
        height={1920}
        durationInFrames={450}
      />
      <Composition
        id="ScenePreview"
        component={ScenePreview}
        defaultProps={previewDefaults}
        calculateMetadata={calculatePreviewMetadata}
        fps={30}
        width={1080}
        height={1920}
        durationInFrames={150}
      />
    </>
  );
}
