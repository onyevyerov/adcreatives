---
model: eleven_text_to_sound_v2
effort: low
max_tokens: 1
cache: true
description: "B5: тексти промптів для стандартних SFX-cue (не LLM-виклик; effort/max_tokens не використовуються)"
---
Тексти для `textToSoundEffects.convert` (promptInfluence 0.6, eleven_text_to_sound_v2): бібліотека
звуків подій ролика. Зведення (`packages/audio/src/mixer.ts`) бере звук кожної події зі `sound` звідси:
по колу перебирає варіанти cue, обрізає тишу на початку, ставить на кадр події (riser закінчується
на кадрі, whoosh/swoosh мають пік на кадрі, решта починається з кадру), а pop/ding/shimmer
підтягує до тональності треку. Варіант 1 стандартних cue хост грає ще й для старого `audio.json`
без `mix` (або коли зведення не вдалося).

Генеруються раз на деплой `pnpm sfx-cache` у `DATA_DIR/cache/sfx/<hash>.mp3` (або `.wav` для
`pcm_44100`); хеш — від тексту, тривалості й формату (`ELEVENLABS_SFX_FORMAT`; `mp3_44100_128` у хеш
не входить), тож зміна рядка тут = новий файл у кеші. Формат рядка (розбирає код):
`- <cue>.<варіант> (<секунди> s): <англійський текст>`; без `.<варіант>` — варіант 1.
Тривалість 0.5–30 с (мінімум API — 0.5). Кожен текст вимагає: звук починається одразу, без тиші
на початку; сухий, без довгого хвоста реверберації; одиночний (один удар, одна нота); гучний і
чистий, по центру стерео («loud and clean, normalized, centered in the stereo image»). pop, ding,
shimmer — одна чітка нота (тон оцінюється й підтягується до тональності). Варіанти одного cue
помітно різні, але в одному сучасному стилі.

Кожен згенерований семпл проходить QC (`packages/audio/src/sfxQc.ts`): пік ≥ −12 dBFS, onset
≤ 50 мс (riser ≤ 400 мс), кореляція L/R ≥ 0.3 (whoosh/swoosh/riser ≥ −0.2), для pop/ding/shimmer —
впевнена висота тону; не пройшов — до 2 повторних генерацій, у кеш — найкраща спроба.
`pnpm sfx-cache --recheck` — QC наявного кешу безкоштовно; `LIVE=1 pnpm sfx-cache --regenerate-failed`
— перегенерувати ті, що не проходять (платно).

- whoosh.1 (0.8 s): A single fast clean air whoosh passing close from left to right, swelling to one sharp peak exactly in the middle and falling away quickly, starts immediately with no silence at the beginning, modern motion graphics transition, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- whoosh.2 (0.8 s): A single deep cinematic whoosh of a heavy object flying past the camera, smooth rise to one clear peak in the middle and a fast fall-off, starts immediately with no silence at the beginning, tight and dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- whoosh.3 (0.7 s): A single bright airy whoosh with a light digital edge, a quick swipe across the screen with one clear peak in the middle, starts immediately with no silence at the beginning, crisp modern interface transition, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- swoosh.1 (0.7 s): A single soft swoosh of fabric swung through the air, gentle rise to one clear peak in the middle and a smooth fall, starts immediately with no silence at the beginning, warm and close, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- swoosh.2 (0.6 s): A single quick thin swoosh of a slim stick cutting the air, one sharp peak in the middle, starts immediately with no silence at the beginning, clean and precise, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- swoosh.3 (0.7 s): A single smooth low swoosh of a card gliding past through the air, soft rise to one clear peak in the middle and a quick fade, starts immediately with no silence at the beginning, polished and modern, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- riser.1 (1.5 s): A single short tension riser of filtered white noise sweeping upward with rising pitch, building steadily louder and cutting off abruptly at its loudest peak at the very end, starts immediately with no silence at the beginning, modern and clean, dry, nothing after the peak, loud and clean, normalized, centered in the stereo image
- riser.2 (2 s): A single cinematic synth riser, a rising tone layered with a growing noise sweep, climbing steadily and stopping dead at its loudest peak at the very end, starts immediately with no silence at the beginning, modern trailer sound, dry, nothing after the peak, loud and clean, normalized, centered in the stereo image
- riser.3 (1.5 s): A single reversed cymbal swell building up fast, getting brighter and louder and ending abruptly at the peak, starts immediately with no silence at the beginning, crisp and modern, dry, nothing after the peak, loud and clean, normalized, centered in the stereo image
- impact.1 (1 s): A single deep punchy cinematic impact hit with a short low boom, hard transient at the very first instant, starts immediately with no silence at the beginning, clean modern trailer accent, dry, short decay, no long reverb tail, loud and clean, normalized, centered in the stereo image
- impact.2 (0.8 s): A single tight sub bass hit, a round low thump with a crisp click on top, starts immediately with no silence at the beginning, modern and polished, dry, quick decay, no reverb tail, loud and clean, normalized, centered in the stereo image
- impact.3 (1 s): A single big drum hit, a huge low tom and a deep boom struck together once, sharp attack at the very start, starts immediately with no silence at the beginning, punchy and modern, dry, short decay, no long reverb tail, loud and clean, normalized, centered in the stereo image
- slam.1 (0.8 s): A single hard punchy slam of a heavy object hitting a solid surface, sharp crack with a dense low body, starts immediately with no silence at the beginning, aggressive and modern, dry, short decay, no reverb tail, loud and clean, normalized, centered in the stereo image
- slam.2 (0.7 s): A single hard-hitting cinematic slam, a saturated low punch with a bright snap on top, starts immediately with no silence at the beginning, tight and modern, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- slam.3 (0.8 s): A single loud stamp slam, a big rubber stamp pressed hard onto a desk once, thick and punchy with a short crack, starts immediately with no silence at the beginning, modern, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- pop.1 (0.5 s): A single short bubbly pop that rings as one clear sustained note around C5, a pure clean tone with no noise, playful bright interface accent, starts immediately with no silence at the beginning, dry, quick decay, no reverb tail, loud and clean, normalized, centered in the stereo image
- pop.2 (0.5 s): A single round plucked pop like a soft marimba tap, one clear sustained note around E5 with a pure clean tone, plump and friendly, starts immediately with no silence at the beginning, modern, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- pop.3 (0.5 s): A single tiny plucky synth pop, one short clean note with a clear tone, modern app notification accent, starts immediately with no silence at the beginning, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- ding.1 (1 s): A single clean bell ding, one pure note with a clear bright tone and a gentle short decay, starts immediately with no silence at the beginning, modern interface success sound, dry, no long reverb tail, loud and clean, normalized, centered in the stereo image
- ding.2 (1 s): A single soft glass ding, a glass tapped once, one clear note with a pure tone, starts immediately with no silence at the beginning, clean and modern, dry, no long reverb tail, loud and clean, normalized, centered in the stereo image
- ding.3 (1 s): A single soft electric piano ding, one round clean note with a clear pitch, friendly modern notification, starts immediately with no silence at the beginning, dry, short decay, no reverb tail, loud and clean, normalized, centered in the stereo image
- tick.1 (0.5 s): A single clean clock tick, one crisp wooden click, starts immediately with no silence at the beginning, dry and precise, no reverb tail, loud and clean, normalized, centered in the stereo image
- tick.2 (0.5 s): A single tiny metallic tick of a watch hand, short and bright, starts immediately with no silence at the beginning, modern and precise, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- tick.3 (0.5 s): A single soft digital tick, one short subtle interface timer tick, starts immediately with no silence at the beginning, clean and modern, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- click.1 (0.5 s): A single crisp subtle interface click, a tight modern app button press, starts immediately with no silence at the beginning, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- click.2 (0.5 s): A single soft mouse click, one short plastic click, starts immediately with no silence at the beginning, clean and close, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- click.3 (0.5 s): A single satisfying toggle switch click, short and solid, starts immediately with no silence at the beginning, modern, dry, no reverb tail, loud and clean, normalized, centered in the stereo image
- shimmer.1 (1.2 s): A single bright chime shimmer, one clear sustained high note around C6 with a pure tone and a faint sparkle on top, starts immediately with no silence at the beginning, elegant and modern, dry, short gentle decay, no long reverb tail, loud and clean, normalized, centered in the stereo image
- shimmer.2 (1.2 s): A single airy glass chime shimmer, one pure high note with a light sparkle on top, starts immediately with no silence at the beginning, clean and elegant, dry, no long reverb tail, loud and clean, normalized, centered in the stereo image
- shimmer.3 (1 s): A single short twinkle, one bright music box note with a quick sparkle, starts immediately with no silence at the beginning, delicate and modern, dry, no long reverb tail, loud and clean, normalized, centered in the stereo image
