import { SceneDurationProvider, TemplateScene } from "@adc/motion-kit";
import type { BrandKit } from "@adc/shared/schemas/brandkit";
import type { Scene } from "@adc/shared/schemas/storyboard";
import type { AssetRef, SceneProps } from "@adc/shared/types/video";
import registry from "@job/scenes";
import { Component, type ComponentType, type ReactNode } from "react";
import { AbsoluteFill } from "remotion";

/** Префікс логу браузера, коли сцена впала в `Main` і замінена шаблоном. */
export const SCENE_ERROR_PREFIX = "ADC_SCENE_ERROR ";

class SceneErrorBoundary extends Component<
  { sceneId: string; fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error) {
    console.error(
      `${SCENE_ERROR_PREFIX}${JSON.stringify({ sceneId: this.props.sceneId, message: error.message })}`,
    );
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Компонент сцени з реєстру задачі (або undefined). */
export function sceneComponent(sceneId: string): ComponentType<SceneProps> | undefined {
  const reg = (registry ?? {}) as Record<string, ComponentType<SceneProps> | undefined>;
  return reg[sceneId];
}

/**
 * Одна сцена: код codegen або `TemplateScene` (у списку templateScenes чи відсутня в реєстрі).
 * `catchErrors` — у `Main` помилка сцени не валить рендер, а підміняє її шаблоном;
 * у `ScenePreview` помилка має дійти до стадії `check`.
 */
export function SceneSlot(props: {
  scene: Scene;
  brand: BrandKit;
  assets: Record<string, AssetRef>;
  useTemplate: boolean;
  catchErrors: boolean;
}) {
  const sceneProps: SceneProps = {
    scene: props.scene,
    brand: props.brand,
    assets: props.assets,
    durationInFrames: props.scene.durationFrames,
  };
  const Code = props.useTemplate ? undefined : sceneComponent(props.scene.id);
  const template = <TemplateScene {...sceneProps} />;
  let content: ReactNode = template;
  if (Code) {
    content = props.catchErrors ? (
      <SceneErrorBoundary sceneId={props.scene.id} fallback={template}>
        <Code {...sceneProps} />
      </SceneErrorBoundary>
    ) : (
      <Code {...sceneProps} />
    );
  }
  return (
    <SceneDurationProvider durationInFrames={props.scene.durationFrames}>
      <AbsoluteFill>{content}</AbsoluteFill>
    </SceneDurationProvider>
  );
}
