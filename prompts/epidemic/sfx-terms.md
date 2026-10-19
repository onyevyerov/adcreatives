---
model: eleven_text_to_sound_v2
effort: low
max_tokens: 1
cache: true
description: "Epidemic: пошукові фрази для 30 cue (не LLM-виклик)"
---
Пошукові фрази для `GET /v0/sound-effects/search` (Epidemic Sound): провайдер SFX `epidemic`
(`ADC_SFX_PROVIDER=epidemic`, `packages/audio/src/epidemic/sfx.ts`) не генерує звук, а шукає готовий
семпл у каталозі. Один пошук на cue (`sort: best-match`, до 30 результатів), варіант `k` cue — `k`-й
кандидат (спершу ті, що не довші за 2× тривалості cue), тож фраза одна на cue, а не на варіант.
Тривалість, атака й обрізання — з `prompts/elevenlabs/sfx-cues.md` і коду, у фразу їх не пишемо:
пошук семантичний, коротка предметна англійська фраза знаходить краще, ніж технічні вимоги.

Формат рядка (розбирає код): `- <cue>: <коротка англійська фраза>`; має бути кожен `SoundCue`.
Зміна фрази = новий пошук і, можливо, нові завантаження (квота безкоштовного тарифу — 50).

- whoosh: fast clean air whoosh transition
- swoosh: soft fabric swoosh through the air
- riser: short tension riser white noise sweep up
- impact: deep punchy cinematic impact hit
- slam: hard heavy slam on a solid surface
- pop: short soft bubble pop
- ding: clean bright bell ding
- tick: single clock tick
- click: subtle interface button click
- shimmer: bright magic chime shimmer
- drop: deep sub bass drop boom
- error: wrong answer buzzer
- alert: two tone attention alert
- glitch: short digital glitch stutter
- scratch: vinyl record scratch stop
- typing: typing on a laptop keyboard
- notify: new message notification chime
- scan: sci-fi laser scanner sweep
- swipe: quick finger swipe on touchscreen
- success: bright success jingle ascending notes
- shutter: camera shutter click
- scribble: marker pen scribble on paper
- flip: single paper page flip
- slide: smooth plastic panel slide
- cash: cash register ka-ching
- lock: padlock snapping shut
- zap: electric spark zap
- snap: single finger snap
- bounce: cartoon boing spring bounce
- cheer: small crowd applause and cheering
