---
model: eleven_text_to_sound_v2
effort: low
max_tokens: 1
cache: true
description: "B5: тексти промптів для стандартних SFX-cue (не LLM-виклик; effort/max_tokens не використовуються)"
---
Тексти для `textToSoundEffects.convert` (promptInfluence 0.6, eleven_text_to_sound_v2).
Генеруються раз на деплой `pnpm sfx-cache` у `DATA_DIR/cache/sfx/<hash>.mp3`; хеш — від тексту
і тривалості, тож зміна рядка тут = новий файл у кеші. Формат рядка (розбирає код):
`- <cue> (<секунди> s): <англійський текст>`; тривалість 0.5–30 с (мінімум API — 0.5).

- whoosh (0.6 s): Fast clean air whoosh passing from left to right, smooth modern UI transition, no reverb tail
- pop (0.5 s): Short soft bubbly pop, playful and clean, bright UI accent, dry
- click (0.5 s): Crisp subtle interface click, tight and dry, modern app button press
- impact (0.8 s): Deep punchy cinematic impact hit with short low boom, clean modern trailer accent
- shimmer (1.2 s): Bright magical sparkle shimmer, airy glittering chimes rising gently, soft and elegant
- swoosh (0.7 s): Smooth soft swoosh of fabric moving through air, gentle and warm transition sound
- riser (1.5 s): Short tension riser building upward with filtered noise and rising pitch, ends abruptly at the peak
- tick (0.5 s): Single clean clock tick, crisp wooden click, dry and precise
