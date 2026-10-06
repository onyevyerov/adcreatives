import { AssetsProvider, MusicTrack, QaProvider, Sfx, ThemeProvider } from "@adc/motion-kit";
import { FORMAT_SIZE } from "@adc/shared/schemas/common";
import { computeTimeline } from "@adc/shared/timeline";
import { TransitionSeries } from "@remotion/transitions";
import { type ReactNode, useMemo } from "react";
import { AbsoluteFill, type CalculateMetadataFunction } from "remotion";
import type { MainInput, ScenePreviewInput } from "./host-props.ts";
import { SceneSlot } from "./SceneSlot.tsx";
import { presentationFor, timingFor } from "./transitions.tsx";

/** Розміри з формату, тривалість — з `computeTimeline` (єдине джерело таймінгів). */
export const calculateMainMetadata: CalculateMetadataFunction<MainInput> = ({ props }) => {
  const { width, height } = FORMAT_SIZE[props.format];
  const timeline = computeTimeline(props.storyboard);
  return { width, height, fps: props.storyboard.fps, durationInFrames: timeline.totalFrames };
};

export const calculatePreviewMetadata: CalculateMetadataFunction<ScenePreviewInput> = ({ props }) => {
  const scene = props.storyboard.scenes.find((s) => s.id === props.sceneId);
  if (!scene) throw new Error(`ScenePreview: сцени ${props.sceneId} немає в розкадровці`);
  const { width, height } = FORMAT_SIZE[props.format];
  return { width, height, fps: props.storyboard.fps, durationInFrames: scene.durationFrames };
};

/** Ролик: сцени через TransitionSeries, музика і SFX — за таймлайном. */
export function Main(props: MainInput) {
  const timeline = useMemo(() => computeTimeline(props.storyboard), [props.storyboard]);
  const templates = useMemo(() => new Set(props.templateScenes), [props.templateScenes]);

  const series: ReactNode[] = [];
  props.storyboard.scenes.forEach((scene, i) => {
    const t = timeline.scenes[i];
    if (t && t.transitionInFrames > 0) {
      series.push(
        <TransitionSeries.Transition
          key={`t-${scene.id}`}
          presentation={presentationFor(scene.transitionIn)}
          timing={timingFor(t.transitionInFrames)}
        />,
      );
    }
    series.push(
      <TransitionSeries.Sequence key={scene.id} durationInFrames={scene.durationFrames} name={scene.id}>
        <SceneSlot
          scene={scene}
          brand={props.brand}
          assets={props.assets}
          useTemplate={templates.has(scene.id)}
          catchErrors
        />
      </TransitionSeries.Sequence>,
    );
  });

  return (
    <ThemeProvider brand={props.brand} fonts={props.fonts}>
      <AssetsProvider assets={props.assets}>
        <QaProvider enabled={props.qa === true}>
          <AbsoluteFill style={{ background: props.brand.palette.background }}>
            <TransitionSeries>{series}</TransitionSeries>
          </AbsoluteFill>
          <MusicTrack audio={props.audio} totalFrames={timeline.totalFrames} />
          {props.storyboard.scenes.map((scene, i) => {
            const t = timeline.scenes[i];
            return scene.sfxCue && t ? (
              <Sfx key={`sfx-${scene.id}`} cue={scene.sfxCue} audio={props.audio} from={t.from} />
            ) : null;
          })}
        </QaProvider>
      </AssetsProvider>
    </ThemeProvider>
  );
}

/** Одна сцена без переходів і звуку — для стілів і QA. */
export function ScenePreview(props: ScenePreviewInput) {
  const scene = props.storyboard.scenes.find((s) => s.id === props.sceneId);
  if (!scene) throw new Error(`ScenePreview: сцени ${props.sceneId} немає в розкадровці`);
  return (
    <ThemeProvider brand={props.brand} fonts={props.fonts}>
      <AssetsProvider assets={props.assets}>
        <QaProvider enabled={props.qa === true}>
          <AbsoluteFill style={{ background: props.brand.palette.background }}>
            <SceneSlot
              scene={scene}
              brand={props.brand}
              assets={props.assets}
              useTemplate={props.useTemplate}
              catchErrors={false}
            />
          </AbsoluteFill>
        </QaProvider>
      </AssetsProvider>
    </ThemeProvider>
  );
}
