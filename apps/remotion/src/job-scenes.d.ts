/**
 * Модуль сцен задачі. Аліас `@job/scenes` → `rev/<n>/video/scenes/index.ts`
 * (у Studio — `src/default-scenes/index.ts`). Контракт index.ts (генерує codegen):
 *
 *   import S1 from "./s1.tsx";
 *   export default { s1: S1 } satisfies Record<string, ComponentType<SceneProps>>;
 */
declare module "@job/scenes" {
  import type { SceneProps } from "@adc/shared/types/video";
  import type { ComponentType } from "react";

  const registry: Record<string, ComponentType<SceneProps>>;
  export default registry;
}
