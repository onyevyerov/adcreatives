import type { TransitionKind } from "@adc/shared/schemas/storyboard";
import {
  linearTiming,
  type TransitionPresentation,
  type TransitionPresentationComponentProps,
  type TransitionTiming,
} from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { none } from "@remotion/transitions/none";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { AbsoluteFill, Easing, interpolate } from "remotion";

type NoProps = Record<string, unknown>;

/** Наїзд: нова сцена з'являється з масштабу 1.15, стара трохи віддаляється. */
function ZoomPresentation(props: TransitionPresentationComponentProps<NoProps>) {
  const p = props.presentationProgress;
  const entering = props.presentationDirection === "entering";
  const scale = entering ? interpolate(p, [0, 1], [1.15, 1]) : interpolate(p, [0, 1], [1, 0.94]);
  return (
    <AbsoluteFill style={{ transform: `scale(${scale})`, opacity: entering ? p : 1 }}>
      {props.children}
    </AbsoluteFill>
  );
}

export function zoom(): TransitionPresentation<NoProps> {
  return { component: ZoomPresentation, props: {} };
}

/** Презентація переходу за `scene.transitionIn`. */
export function presentationFor(kind: TransitionKind): TransitionPresentation<Record<string, unknown>> {
  switch (kind) {
    case "cut":
      return none() as TransitionPresentation<Record<string, unknown>>;
    case "fade":
      return fade() as TransitionPresentation<Record<string, unknown>>;
    case "slide":
      return slide({ direction: "from-right" }) as TransitionPresentation<Record<string, unknown>>;
    case "wipe":
      return wipe({ direction: "from-left" }) as TransitionPresentation<Record<string, unknown>>;
    case "zoom":
      return zoom() as TransitionPresentation<Record<string, unknown>>;
  }
}

export function timingFor(frames: number): TransitionTiming {
  return linearTiming({ durationInFrames: frames, easing: Easing.inOut(Easing.cubic) });
}
