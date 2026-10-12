import type { SceneProps } from "@adc/motion-kit";
import type { ComponentType } from "react";
import CtaLogo from "./cta-logo.tsx";
import DeviceReveal from "./device-reveal.tsx";
import HookPhoto from "./hook-photo.tsx";
import OfferPrice from "./offer-price.tsx";
import Proof from "./proof.tsx";
import Typographic from "./typographic.tsx";
import UiDemo from "./ui-demo.tsx";

/** Реєстр еталонних сцен (для Studio і тестів), ключ — назва файлу. */
export const exampleScenes: Record<string, ComponentType<SceneProps>> = {
  "hook-photo": HookPhoto,
  "offer-price": OfferPrice,
  typographic: Typographic,
  proof: Proof,
  "cta-logo": CtaLogo,
  "device-reveal": DeviceReveal,
  "ui-demo": UiDemo,
};
