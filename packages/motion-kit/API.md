# `@adc/motion-kit` — how the components behave

This file is read by the model that writes and repairs scene files. It describes what the components of `@adc/motion-kit` actually do at render time: defaults, timings in frames, what each prop changes, and which quality checks each component runs on itself. It deliberately repeats no type signatures (they are in the declarations that follow this file) and no rules of the scene contract (they are in the main brief). When this file and the declarations disagree about a name or a type, the declarations win; when they disagree about behaviour, this file is the one that was written by hand and is more likely right.

All frame numbers below are at 30 fps. "Settled" means the element has reached its final position and opacity to within about 1%.

The exports that are not described here (`ThemeProvider`, `AssetsProvider`, `SceneDurationProvider`, `QaProvider`, `qaLog`, `parseQaLog`, `MusicTrack`, `Sfx`, `TemplateScene`, `templateVariantFor`, `planFont`, `pruneFontInfo`, `monoChoice`, `MONO_FAMILY`, `useBrand`, `useAssets`, `useSceneDuration`, `buildTheme`) exist for the host composition. They are already set up around every scene. A scene never renders or calls them: a second `ThemeProvider` or `AssetsProvider` inside a scene breaks fonts and asset lookup for everything inside it.

## Theme: `useTheme()`, colours, radii

`useTheme()` returns the brand kit reduced to what a scene needs. `palette` has seven brand colours, `primary`, `secondary`, `accent`, `background`, `surface`, `textOnDark`, `textOnLight`, and three semantic ones that are always there: `danger` (a problem, an error, a critical finding), `warning` (moderate, needs attention) and `success` (done, fixed, passed). The brand kit derives the semantic colours from the brand; an older brand kit without them gets the base colours `#EF4444`, `#F59E0B` and `#22C55E`. They are for meaning, not decoration: a red status in a mock, a struck-out problem, a `Backdrop` `tint` for the problem scene, a green tick once it is fixed; `mix(theme.palette.danger, theme.palette.surface, 0.85)` gives the pale row fill behind a danger status. `fonts.heading` and `fonts.body` are CSS font-family strings; the fonts are loaded before the scene renders, so text measurement is exact. `fonts.mono` is the monospaced font for numbers, eyebrows, statuses and labels in mocks: the brand kit's mono font, or `JetBrains Mono` when the brand kit names none, loaded the same way as the other two when the renderer supplies it, and always ending in the system `ui-monospace, monospace`, so it is a valid stack even when nothing was loaded. `motion` is the brand's motion personality (`energetic`, `calm`, `premium`, `playful`) and `density` is `airy`, `balanced` or `dense`.

`radius` holds corner radii in px for a frame whose short side is 1080, chosen from the brand's `visualStyle.shapes`: `rounded` gives sm 12, md 24, lg 44; `organic` gives 18, 36, 64; `geometric` gives 4, 8, 14. `pill` is 999 for all three (a pill is always fully round). Multiply a radius by `useFormat().unit` when you use it yourself; the components that take a radius from the theme already do.

Colour helpers, all pure functions on CSS colour strings (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`):

- `readableOn(background, theme.palette)` returns whichever of `textOnDark` and `textOnLight` has more contrast against `background`; if neither reaches 3:1 it falls back to pure white or near-black (`#111111`). Always pass the palette; without it the function only knows white and black.
- `mix(a, b, t)` blends two colours (t = 0 is `a`, t = 1 is `b`); `withAlpha(color, alpha)` returns an `rgba()` string; `contrastRatio(a, b)` is the WCAG ratio from 1 to 21; `isDark(color)` is true when relative luminance is below 0.4; `minContrastFor(fontSizePx)` is the threshold the checks use, 3:1 for text of 36 px or more and 4.5:1 below that.

Motion helpers tied to the brand: `springFor(theme.motion)` returns `springs.snappy` for `energetic` and `playful`, `springs.soft` for `calm`, `springs.premium` for `premium`. `defaultStagger(theme.motion, by)` returns the frames between words that the text components use when you give no `stagger`: 3 for `energetic`, 4 for `playful`, 5 for `calm`, 6 for `premium` per word, and 2.5 times that per line (8, 10, 13, 15).

## Format and safe area: `useFormat()`, `SafeArea`

`useFormat()` reads the composition size and returns `format`, `width`, `height`, `isVertical`, `isLandscape`, `unit` and `safe`. `unit` is the short side divided by 1080, so it is exactly 1 in all three standard formats; it exists so that sizes written as `n * unit` survive a future change of resolution, and the contract asks for it.

`safe` is the rectangle where social apps draw nothing over the video. Its values in the three formats:

| format | frame | safe x, y | safe width × height | what is cut off |
| --- | --- | --- | --- | --- |
| vertical | 1080 × 1920 | 120, 240 | 840 × 1277 | 240 px at the top (app header), 403 px at the bottom (caption and buttons), 120 px each side (reaction rail; symmetric so centred text stays centred) |
| square | 1080 × 1080 | 80, 80 | 920 × 920 | 80 px on each side |
| landscape | 1920 × 1080 | 96, 80 | 1728 × 892 | 80 px at the top, 108 px at the bottom (player controls), 96 px each side |

So the vertical frame has about two thirds of its height available and a column 840 px wide; the landscape frame has a wide, short band; the square frame is nearly all usable.

`<SafeArea>` is an absolutely positioned `div` exactly covering `safe`, with `display: flex; flexDirection: column` and `boxSizing: border-box`. That means `justifyContent`, `alignItems` and `gap` passed through `style` arrange its children at once; `justifyContent: "flex-end"` puts a text block just above the bottom band, `center` centres it. `padding` defaults to 0.

How the safe-area check works: in QA mode each text component, `Pill`, `CTAButton` and `Logo` measures its own bounding box after the frame is laid out and logs `outside_safe_area` if the box leaves `safe` by more than 4 px. The box is the whole element, not the glyphs. A text block's default `width` is `safe.width` regardless of where it sits, so a text block inside a `SafeArea` with `padding`, inside a half-width column, or beside a photo, must be given its own `width` (the width of its column) or it will stick out of the column on the right and, with padding, out of the safe area. Elements with effective opacity below 0.05 are not checked, so an element that has not entered yet is fine.

`formatInfoFor(width, height)` is the pure function behind `useFormat()`; `SAFE_MARGINS` holds the fractions above; `isInsideRect(inner, outer, tolerance = 4)` is the test the check uses.

## Text: `Headline`, `Body`, `KineticText`, `FitText`

All four draw through one internal block that fits, wraps, colours and animates the text. What they share:

- **Fitting.** The text is wrapped greedily into lines at most `width × 0.97` wide and the font size is lowered from `maxFontSize` towards `minFontSize` until it fits in `maxLines`. If it fits only at the minimum, the block logs `text_min_size` (the art director reads this as "too small"); if it does not fit even at the minimum, or a single word is wider than the block, it logs `text_overflow`. A word is never broken.
- **Defaults.** `width` is `safe.width`. `align` is `center`, and a centred block gets `margin: 0 auto`, so a narrower `width` still sits in the middle of its container. `color` is `theme.palette.textOnLight`: that is dark text, right on a light `Backdrop` and wrong on a photo with a darkening overlay or on a dark gradient, where you must pass `color` yourself (`readableOn(bg, theme.palette)`, `theme.palette.textOnDark`, or white on a darkened photo). The font is `heading` with the heaviest heading weight for `Headline`, `KineticText` and `FitText`, and `body` with the weight closest to 400 for `Body`. Line height is 1.1 for heading text and 1.3 for body text. `startFrame` defaults to 0.
- **Emphasis.** `emphasis` is a list of words or phrases; every word of the text that matches one of them (case-insensitive, ignoring punctuation at the edges, phrases matched as consecutive words) is coloured `accent`. With the `highlight` preset the match gets a marker instead (below).
- **Checks.** Besides fitting, every block checks that its box is inside the safe area and that its text colour has enough contrast against the background found at the centre of the block (see "How contrast is checked" at the end).

**Presets.** Without `preset` the text is static and visible from frame 0; `startFrame` then does nothing. With a preset the text appears element by element, where an element is a word (`by="word"`, the default) or a line (`by="line"`). Element `i` starts at `startFrame + i × stagger` and runs on its own local clock. The presets at 30 fps:

| preset | what each element does | settled after its local start |
| --- | --- | --- |
| `rise` | fades in over 8 frames while sliding up 0.6 em with `springFor(theme.motion)` | 12 frames for energetic/playful, 20 for calm, 29 for premium |
| `fade` | opacity 0 → 1 over 12 frames with `easings.out` | 12 frames |
| `scale` | fades in over 6 frames while scaling 0.6 → 1 with `springFor(theme.motion)` | 12 / 20 / 29 frames as for `rise` |
| `highlight` | every word fades in over 8 frames; each `emphasis` phrase gets one marker in `accent` under the whole phrase (one rectangle per phrase and line, not per word), growing from the left from local frame 6 of its first word for 12 frames plus the phrase's own stagger; each word of the phrase switches to `readableOn(accent)` when the marker reaches its middle. The marker reaches 0.1 em past the words left, right and below, so descenders (у, д, р) and the first and last letters never touch its edge. A phrase that wraps gets one marker per line. Without `emphasis` it is just a quick fade | 18 frames after the last word of the phrase |
| `typewriter` | characters appear left to right across the whole text at 30 characters per second for `energetic`, 26 for `playful`, 18 for `calm`, 15 for `premium`; not-yet-typed characters hold their space, so the layout does not shift. `stagger` and `by` do not apply | `characters ÷ speed` seconds, so a 36-character headline takes 36, 42, 60 or 72 frames |

The last element of a block starts at `startFrame + (elements − 1) × stagger`, so a block is fully readable at about `startFrame + (elements − 1) × stagger + settle`. Example: a six-word headline with `rise`, `energetic` brand, default stagger 3, starting at frame 10 is settled at about frame 10 + 15 + 12 = 37; the same headline for a `premium` brand (stagger 6, settle 29) is settled at about frame 69. `by="line"` has far fewer elements and is the fast way in for long text.

**The four components.**

- `Headline` uses the heading font and these sizes in px before `× unit`: `m` 76 down to 44, `l` 100 down to 52, `xl` 128 down to 60. Default `size` is `l`, default `maxLines` 3. `xl` fits only a few words on one line in vertical and square (840 and 920 px wide); in landscape with a text column of half the safe width it usually shrinks to its minimum.
- `Body` uses the body font: `s` 34 down to 26, `m` 42 down to 30, `l` 54 down to 34. Default `size` is `m`, default `maxLines` 3. When `Body` has a `preset` it always animates line by line; it has no `by` prop.
- `KineticText` is the same block with the sizes given explicitly (`maxFontSize`, `minFontSize`), a required `preset`, and `by`, `stagger`, `font` exposed. Default `maxLines` 3. Use it when the headline sizes do not fit the design, for example a single giant word.
- `FitText` is the static version with explicit sizes and `weight`; default `maxLines` 2. It accepts no preset.

## `Pill` and `CTAButton`

Both are inline-flex boxes in the heading font at its heaviest weight, filled with `theme.palette[variant]` and lettered in `readableOn` of that colour, with `alignSelf: center` so they sit centred inside a `SafeArea` column unless you position them. Both check the safe area and contrast on themselves.

`Pill` sizes (`s`, `m`, `l`) are 30, 42 and 60 px before `× unit`, default `m`, padding 0.32 em vertical and 0.85 em horizontal, fully round unless the brand's `radius.pill` is 0 (then square corners). Default `variant` is `accent`. With `startFrame` it springs in with `springs.snappy` (scale 0.5 → 1, opacity reaching 1 at about frame 4 after start, settled by frame 12, with a 5% overshoot around frame 7); without `startFrame` it is simply there from frame 0.

`CTAButton` sizes (`m`, `l`) are 44 and 56 px, default `l`, padding 0.6 em vertical and 1.4 em horizontal, a soft drop shadow, default `variant` `accent`. `startFrame` defaults to 0, so it always enters with `springs.snappy` (scale 0.6 → 1, settled by frame 12). From 18 frames after `startFrame` it pulses, scaling up to 4% with a period of 1.25 seconds, and never stops. You do not animate it further.

Both keep their text on one line and fit it to the available width: the font size is reduced to as little as 60% of the nominal size until the box fits the width of its container (or `style.maxWidth` if you set one). If it had to shrink, the component logs `text_min_size`; if it does not fit even at 60%, `text_overflow`. A `Pill` is meant for a figure or one or two words (a price, a percentage, a short badge); a long `brand.cta.text` on a `CTAButton` in a narrow landscape column is the usual way to hit the shrink, and `size="m"` or a wider column avoids it.

## Photos: `BrandImage`

`BrandImage` draws the photo whose `assetId` is one of `props.scene.assetIds`, from the revision's assets that the host already provides.

- **Where it goes.** By default the component is `position: absolute; inset: 0; overflow: hidden`, so it fills its nearest positioned ancestor (an `AbsoluteFill` makes it full-frame). To frame the photo instead, pass `style` with a size and position (`width`, `height`, `left`, `top`, or `position: "relative"` inside a flex layout); whatever you pass is merged over the defaults.
- **Crop.** `fit` is `cover` by default (fill the box, crop the excess) or `contain` (show the whole photo, leave bars). `focal` is the point of the photo kept in view, as fractions 0–1 of width and height; it defaults to the focal point stored with the asset and is also the origin of the Ken Burns scale, so the zoom moves towards the subject.
- **Ken Burns.** `kenBurns: { from, to, direction }` scales the photo from `from` to `to`, both clamped to 1.0–1.25, with `easings.inOut` from `startFrame` (default 0) to the end of the scene; it uses the scene's real length, so it never stops early. `direction` defaults to `in`; `out` plays the larger value first; `left`, `right`, `up` and `down` add a pan across the room the scale leaves at the edges, which is `(min(from, to) − 1) / (2 × min(from, to))` of the size each way, so `from: 1.15, to: 1.15, direction: "left"` pans about 6.5% of the width each way (13% in total) and `from: 1, to: 1` with any direction does not move at all. A pan needs a scale above 1 on both ends.
- **Parallax.** `parallax: n` moves the photo `n` px vertically over the scene, from `n/2` above to `n/2` below its resting place, eased like Ken Burns; the image is drawn `n/2` px taller on each side so no edge shows.
- **Mask and corners.** `mask: { type: "circle" }` is a circle (or ellipse if the box is not square); `blob` is a fixed organic shape; `diagonal` clips the bottom edge to a slope from the full height at the left up to 86% at the right (plus `radius` if given); `rounded` uses `radius` or, when it is missing, `theme.radius.lg × unit`. With no `mask`, `radius` alone rounds the corners by that many px.
- **Overlay.** `overlay: { color, opacity }` lays a flat colour over the photo at that opacity, for text on top. For the contrast check, an overlay of 0.45 or more makes the photo count as a solid background (a mid-grey mixed with the overlay colour); below 0.45 the background under text is treated as unknown, the automatic contrast check stays silent, and only the art director's eyes judge it.
- **Appearance.** Without `startFrame` the photo is visible from frame 0. With `startFrame` it is invisible before that frame and fades in over 10 frames with `easings.out`, and its Ken Burns and parallax start there too. Any other reveal (a wipe, a growing circle, a slide) is done by wrapping `BrandImage` in a `div` whose `clipPath`, `transform` or `opacity` you drive from the frame; the component itself does only the fade.
- **Checks.** `missing_asset` when `assetId` is not in the assets (the component then draws a `surface`-coloured box, so the scene still renders); `upscaled_image` when the photo has to be scaled by more than 2× to fill its box, counting the largest Ken Burns scale (a 900 × 600 photo filling a 1080 × 1920 frame is 3.2×, a 1600 × 1067 photo in a 540 × 720 framed box is well under); `stretched_image` when the asset's declared proportions differ from the file by more than 3%.

## `Logo`

`Logo` draws the brand's logo asset at `size` px high (default `120 × unit`), width from the asset's proportions. If the brand has no logo image it draws `brand.logo.textFallback` (or the brand name) in the heading font at 72% of `size`, on one line.

`variant` says what the logo stands on and decides the plate and the fallback colour: `onDark` for a dark background, `onLight` for a light one, `auto` (default) for the brand background. When `brand.logo.needsBackground` is true the logo gets a plate with padding: white for `onDark`, `primary` for `onLight`, `surface` for `auto`, with `theme.radius.md × unit` corners; the fallback text is then `readableOn` the plate. Without a plate, fallback text is `textOnDark` for `onDark`, `textOnLight` for `onLight`, and for `auto` `textOnDark` if the brand background is dark, else `primary`.

With `startFrame` the logo enters with `springs.premium` whatever the brand's personality (opacity reaching 1 around frame 11 after start, scale 0.8 → 1 settled by frame 29); without it, it is simply there. It has `alignSelf: center`. It checks the safe area always, and contrast only for fallback text.

### Vector logo: `useLogoGeometry()`, `LogoPath`

`useLogoGeometry()` returns the shapes of the brand's logo when the logo is an SVG file (`brand.logo.type` is `svg`): `viewBox` is the file's viewBox and `paths` is one `d` string per visible shape, in viewBox coordinates, with the transforms of its groups already applied (rects, circles, ellipses, lines, polylines and polygons are converted to paths; shapes inside `defs`, masks and clip paths, hidden shapes and a background rectangle covering the whole viewBox are left out). It returns `null` for a raster or text logo, for an SVG that contains `<text>`, an embedded raster image or `<use>`, and when the file cannot be read; the scene then shows `<Logo>` instead. Always write both branches: `const geometry = useLogoGeometry();` then `geometry ? <LogoPath …/> : <Logo …/>`. The first frame waits until the file is read, so the answer is the same on every frame.

`LogoPath` draws that logo as a line drawing in one colour. `size` is its height in px; the width follows the viewBox proportions. `draw` (0–1, default 1) is how much of every outline is drawn: all shapes draw at once, each from its own start, so `draw={progress(frame, at, 30, easings.inOut)}` draws the logo in over 30 frames; at 0 it is invisible. From `draw` 0.6 to 1 the filled shapes of the logo fill in with the same colour while their outline fades, so at 1 the logo stands as a solid one-colour silhouette; shapes that are only stroked in the file keep their own stroke width and stay lines. `stroke` is the colour (default: the colour `<Logo>` would use for fallback text on the brand background, `textOnDark` on a dark background, else `primary`); pass `readableOn(background, theme.palette)` or `textOnDark` when it stands on something else. `strokeWidth` is the outline width in px (default `max(1.5 × unit, size / 60)`). It renders nothing for a raster or text logo. It checks the safe area like `Logo`. It is a single colour by design: for a multicolour logo, draw it with `LogoPath` and then cross-fade to `<Logo>` at the same `size` (both centred in the same box) once it has filled in.

## `Backdrop`

`Backdrop` is an `AbsoluteFill` behind everything; render it first in the tree. `color` defaults to `theme.palette.background` and is the base of `solid`, `noise`, `shapes` and `stage`.

- `stage`: a living room for the film, moving on every frame without `animate`. Over the base colour lie two large soft radial glows (radius 75% of the short side, colours `glow`, default `[primary, secondary]`, at 55% opacity on a dark base and 35% on a light one), one upper left and one lower right, each drifting on its own slow sine curves by up to 8% of the width and 6% of the height (about 1 px per frame; the two never move in step); a fine grid of 96 × unit px lines, faint white on a dark base and faint black on a light one, strongest in the centre and fading out towards the edges, drifting upwards by 0.4 × unit px per frame (`grid={false}` removes it); a monochrome film grain whose pattern changes every frame and repeats every 9 frames; and a vignette darkening the corners. `tint` is a colour the glows turn into and `tintAmount` (0–1, default 1 when `tint` is given) how far: `tint={theme.palette.danger}` turns the room red for the problem scene, and `tintAmount={progress(frame, at, 20)}` makes the room change colour on the beat while the base stays the same. Several `stage` backdrops in a row are one continuous room, which is the point: use it as the default background of the film and vary `glow` and `tint` between scenes rather than switching variants.

- `solid`: one flat colour.
- `gradient`: a linear gradient through `colors` (default `primary → secondary`) at `angle` degrees (default 160). `animate` turns the angle by 0.12° per frame, about 18° over a 150-frame scene: slow but visible.
- `noise`: the base colour with a fine monochrome grain at 16% in multiply blend and a soft vignette darkening the edges; `animate` drifts the grain.
- `shapes`: the base colour with five large blurred circles (radius 28–58% of the short side) in fixed pseudo-random positions, coloured in turn from `colors` (default `primary`, `secondary`, `accent`) at 22% opacity; `animate` drifts them by up to 4% of the short side on slow sine curves. The positions are the same in every scene and every video, so two `shapes` backdrops in a row look identical.

For the contrast check a `Backdrop` reports its base colour (`gradient` reports the average of its stops; `stage` reports its base, not the glows, so pick text colours against the base and keep text away from a strong glow of a similar lightness), so text on a gradient from a light to a dark colour may pass the check at the centre and still be hard to read at one end; pick text colours against the actual stop the text sits on.

## Motion helpers: `springs`, `easings`, `progress`

`springs` are three configurations for remotion's `spring({ frame, fps, config })`, measured at 30 fps from frame 0:

| config | 90% at frame | settled at frame | overshoot | character |
| --- | --- | --- | --- | --- |
| `snappy` | 5 | 12 | +5.6% around frame 7 | fast, with a bounce: prices, badges, buttons, energetic and playful brands |
| `soft` | 12 | 20 | none | smooth, no bounce: body text, photos, calm brands |
| `premium` | 17 | 29 | none (clamped) | slow and exact: logos, premium brands |

A spring evaluated at a frame before its start (`frame − startFrame < 0`) returns 0, so `spring({ frame: frame - start, fps, config })` is already a clean delayed entrance.

`easings.out` and `easings.inOut` are cubic, `easings.expoOut` is exponential (very fast start, long tail), `easings.backOut` overshoots (back(1.6)) and then returns; all are for `interpolate(…, { easing })`.

`progress(frame, startFrame, duration, easing?)` returns 0 before `startFrame`, 1 after `startFrame + duration`, and the eased fraction between, clamped. It is the simplest way to drive a wipe, a `clipPath`, a colour field or a counter-movement, and to reuse one value in two places so that elements react to each other.

## Devices: `useBeat`, `ColorField`, `ClipReveal`, `DrawPath`, `MorphShape`, `Breathe`

Ready-made moves; prefer one to building the same move by hand. Each is a pure function of the frame, clamped before its start and after its end; colours are palette roles (`color="accent"`), never CSS colours; px defaults are already `× unit`. Durations default to `easings.inOut`. Example: `examples/device-reveal.tsx`.

- `useBeat(at, opts?)`: 0 → 1 from frame `at`, a `spring` with `springFor(theme.motion)` (0 before `at`; `snappy` overshoots ~5%), or with `opts.duration` a clamped `progress` (`easings.out`). Read one beat in two elements so they react to each other: `const b = useBeat(photoAt)`, then `(1 - b) * 60 * unit` as the text block's `translateY`.
- `ColorField`: full-frame layer; `children` are the frame under it. A `theme.palette[color]` field (default `primary`) enters from `from` (default `left`) over `duration` (15) from `startFrame`. `mode`: `wipe` (default) grows from the edge, `split` closes two halves from both edges, `push` slides a panel in and pushes `children` by the same distance. `cover` (0–1, default 1) is the share it ends up covering (`0.4`: a side panel). From `exitFrame` it leaves: `wipe` carries on across, `split` and `push` go back. Text drawn after it is contrast-checked against the field.
  `<ColorField mode="push" from="right" cover={0.45} startFrame={20}><BrandImage assetId={id} /></ColorField>`
- `ClipReveal`: reveals `children` by `clipPath` over `duration` (18) from `startFrame`; fully clipped before, unclipped after. `shape`: `inset` (default) a rectangle, `circle` grows to the farthest corner, `polygon` a slanted edge (from `center`: a diamond); `from`: `center` (default) or an edge. Like `BrandImage` it fills its nearest positioned ancestor unless `style` sizes it.
  `<ClipReveal shape="circle" startFrame={12} style={{ position: "relative", width: 600 * unit, height: 600 * unit }}>…</ClipReveal>`
- `DrawPath`: a `width × height` block whose path `d` (in `viewBox` units, default `0 0 width height`) is drawn start to end over `duration` (24) with `evolvePath`; colour default `accent`, `strokeWidth` default `8 × unit`, round caps, invisible before `startFrame`.
  `<DrawPath d="M 6 18 Q 160 2 314 18" width={320} height={24} startFrame={lineAt} />`
- `MorphShape`: one rounded box at `x`, `y` (nearest positioned ancestor) moving through `keys`. The first key holds from frame 0; each next key starts at its `at` (default: previous start + `duration`) and is reached `duration` (18) frames later. A key without `radius` or `color` keeps the previous one (first: `theme.radius.lg × unit`, `primary`); the radius is capped at half the short side, so `999` is a pill. Children are centred and clipped and are contrast-checked against its colour. A card that becomes a button:
  `<MorphShape keys={[{ x: 120, y: 700, width: 840, height: 520, color: "surface" }, { at: 60, x: 290, y: 1300, width: 500, height: 120, radius: 999, color: "accent" }]} />`
- `Breathe`: full-frame layer that from `startFrame` scales its children by up to `amount` (0.006) and lifts them `drift` px (0) on a cosine of `period` frames (energetic 45, playful 54, calm 75, premium 90), starting from rest. It scales about the safe-area centre; the default keeps text at the safe edge within the check's 4 px tolerance, a larger `amount` may log `outside_safe_area`. Wrap the `SafeArea` once everything has landed.

Checks: `DrawPath` and `MorphShape` log `outside_safe_area` unless `bleed` is set (for decoration meant to reach the frame edge). The other devices check nothing themselves; text and images inside them check themselves.

## Motion blur: `MotionBlur`, `Trail`

Filled in by B1.

## Camera: `Camera`, `useCamera`

Filled in by B2.

## Showing the product: icons, data, interface, effects

Ready-made pieces for scenes that show the product at work: an address typed into a field, a page being scanned, checks ticking off, a number counting up, a ring or bars filling, a competitor's price struck out. Each is a pure function of the frame, like the devices: before its start it shows its start state, after its end its end state, and the same frame always gives the same picture. Colours default to palette roles; every `color` prop takes either a palette role (`"accent"`, `"primary"`, `"surface"`…) or a CSS colour. Example: `examples/ui-demo.tsx`.

Rules for the data these pieces show:

- **Texts come from `props.scene.items`**, word for word: `items.find((i) => i.role === "number")?.text`, `items.filter((i) => i.role === "item").map((i) => i.text)`. The storyboard put them there; their `role` and `group` say what each one is.
- **Numbers come from those texts through `numberIn(text)`**, never as literals: `numberIn("~50 перевірок")` is 50, `numberIn("від $300–2000")` is 300, `numberIn("рейтинг 4,9")` is 4.9, `numberIn("1 200 грн")` is 1200, a text without digits gives `null`. It returns the first number of the text without its sign (`"-10%"` gives 10); groups of three digits after a space, comma, dot or apostrophe are thousands, one or two digits (or three after a leading 0) after a comma or dot are a decimal fraction.
- **Moments come from `props.scene.events` through `eventFrame(props.scene, "event-id")`**, which returns the local frame of that event. The sound of the event is placed on exactly that frame, so the visible moment (the click, the tick, the counter starting, the strike) must start there: `const pressAt = eventFrame(props.scene, "press")`, then `pressAt={pressAt}`. An id that the scene does not have throws, and the render fails with a message naming the ids it does have.

**`Icon`** draws one of the built-in lucide icons (`name` is checked by the type `IconName`; the declarations list every name, an unknown one does not compile). It is an `svg` of `size × size` px on lucide's 24 × 24 grid, stroked, no fill. `color` defaults to `accent`; `strokeWidth` (default 2, as in lucide) is in grid units, so it scales with `size`. `draw` (0–1, default 1) is how much of every stroke is drawn: all strokes of the icon draw at once from their own start, so `draw={progress(frame, at, 14, easings.out)}` draws it in over 14 frames; at 0 the icon is invisible. `style` goes to the `svg`. Icons are decoration and check nothing.

**`CountUp`** draws `text` (word for word, through the same fitting block as `FitText`) with its first number running from 0 to its value, from `startFrame` over `durationFrames` with `easings.out`; from frame `startFrame + durationFrames` on it is exactly `text`. Before `startFrame` it shows 0 (`"~0 перевірок"`). The layout is that of the final text: digits are tabular and digits not yet reached hold their place invisibly, so nothing shifts while it counts (a right-aligned odometer). Defaults: `maxFontSize` 140 × unit, `minFontSize` 56 × unit, `maxLines` 2, the heading font, `width` the safe width, `align` center, colour `textOnLight`; all of them, `font`, `weight`, `color`, `align` and `style`, can be passed (`TextStyleProps`). It runs the text checks (`text_overflow`, `text_min_size`, safe area, contrast) as `CountUp`. It does not fade in by itself: drive `style.opacity` or wrap it if it should appear.

**`Ring`** is a donut chart `size` px wide, `thickness` px thick (default 12% of `size`), starting at the top and going clockwise, on a faint `primary` track (`track` to change it). Segment `i` takes `value / total` of the circle (`total` defaults to the sum of the values, a full ring; for one percentage pass `total: 100`), and draws from `startFrame + i × stagger` (stagger default 8) over `durationFrames` (default 24) with `easings.out`. Segment colours default to `accent`, `primary`, `secondary` in turn; several segments get a small gap between them. `children` are centred in the ring: put the `CountUp` of the same number there.

**`Bars`** is a bar chart filling a `width × height` box: `vertical` (default) bars grow up from the bottom, `horizontal` bars grow right from the left edge. Values are scaled so that `max` (default the largest value) fills the box; bar `i` grows from `startFrame + i × stagger` (default 4) with `springFor(theme.motion)` (energetic and playful brands overshoot about 5%, so leave a little room). Bars are `color` (default `primary`), bar index `highlight` is `accent`; `gap` is the share of each slot left empty (default 0.3); corners use `theme.radius.sm × unit`. Labels are yours: draw them with `FitText` next to the box.

**`UICard`** is a panel of the product's interface: `surface` fill, `readableOn(surface)` as its text colour, corners `theme.radius.lg × unit`, padding 36 × unit, a soft shadow, a column with 20 × unit gap. It enters from `startFrame` with `springFor(theme.motion)`, rising 48 × unit and scaling from 0.96, opacity reaching 1 after 6 frames. `accent` adds a stripe of that colour down its left edge. `title` (with an optional `icon` beside it) is fitted with `FitText` (46 × unit down to 70%, two lines); `children` follow below it. Its default `width` is the safe width; pass `width` when it sits in a column. Text drawn inside it is contrast-checked against `surface`; pass `color={readableOn(theme.palette.surface, theme.palette)}` to text components inside.

**`Checkbox`** is a `size × size` box. Before `checkedAt` it is an empty rounded square outlined in `color` (default `accent`); at `checkedAt` the fill pops in with `springs.snappy` (settled by frame 12) and a check mark in `readableOn(color)` draws over 8 frames from `checkedAt + 2`. Put the tick sound's event on `checkedAt`.

**`Checklist`** is a column `width` px wide of rows `[Checkbox, text]`. Row `i` slides in from the left (40 × unit, `springFor(theme.motion)`, opacity over 6 frames) from `startFrame + i × stagger` (default `defaultStagger(theme.motion, "line")`: 8, 10, 13 or 15). Box `i` is checked at `checkAt[i]` when `checkAt` is given, otherwise at `checkFrom + i × checkStagger` (`checkFrom` defaults to 12 frames after the last row starts, `checkStagger` to `stagger`). The texts use the body font, up to two lines each, all at one size: the largest at which the longest item fits, from `fontSize` (default 48 × unit) down to 70% of it; the box is 1.1 × `fontSize`. Text colour `color` defaults to `textOnLight`, box colour `checkColor` to `accent`. Each text runs the `FitText` checks.

**`InputField`** is a search or address field `width` px wide and 2.3 × `fontSize` high (`fontSize` default 44 × unit), `surface`-filled with a thin border and a shadow. Before `typeStart` it shows `placeholder` (if any, at 45% opacity) and a blinking caret (15 frames on, 15 off). From `typeStart` `text` is typed one character every `framesPerChar` frames (default 2): the first character appears at `typeStart`, the last at `typeStart + (length − 1) × framesPerChar`, so a 15-character address at the default speed takes 29 frames. The text is laid out for its full length from the start (body font, one line, shrinking to 60% if needed, with the `FitText` checks), so it never moves while it is typed. The caret is solid while typing and blinks afterwards; the border turns `accent` as typing starts. `icon` draws an icon at the left; `buttonLabel` draws an `accent` button at the right, which is pressed at `pressAt` (it shrinks by 8% and returns over 8 frames); after `pressAt` there is no caret. A `Cursor` click on the button and a click sound belong on the same `pressAt`.

**`Cursor`** is a mouse pointer whose tip is at `path` points (px in the nearest positioned ancestor, so put it in an `AbsoluteFill` and give frame coordinates). It stays at the first point until that point's frame, moves between points with `easings.inOut`, and stays at the last one. `clickAt` (one frame or several) makes it squeeze for 6 frames and sends an `accent` ring out from the tip over 18 frames. `size` defaults to 56 × unit. It is dark with a light outline (`textOnLight` on `textOnDark`).

**`ScanLine`** is a glowing line in `color` (default `accent`), `thickness` px (default 4 × unit), with a fading trail `trail` px long behind it (default 140 × unit). With `axis: "y"` (default) the line is horizontal, spans the full width of its nearest positioned ancestor and moves from `top = from` to `top = to` px; with `"x"` it is vertical and moves across. It moves from `startFrame` over `durationFrames` with `easings.inOut`, appears over 4 frames, fades over 6 frames after the end and draws nothing outside that. Typical use: in the scene's `AbsoluteFill`, from just under the field to the bottom of the safe area, while the results appear row by row behind it.

**`Flash`** is a full-frame layer of `color` (default `textOnDark`, usually white) at opacity `strength` (default 0.8) on frame `at`, fading out over `durationFrames` (default 10) with `easings.out`; before `at` and after the fade it draws nothing. Render it last so it covers everything. It is the cut inside a scene (between its two states) or the hit of an impact sound.

**`Glow`** wraps `children` in a `div` with a glow of `color` (default `accent`) around their opaque pixels (two `drop-shadow` filters, radius 28 × unit × `strength`, default 1). `startFrame` makes it build up over 12 frames from that frame (without it, it glows from frame 0); `pulse` makes it breathe between 60% and 100% with a period from the brand's motion (energetic 30, playful 36, calm 60, premium 72 frames). Use it on a number or a button once it has landed, not on body text.

**`Strike`** is an inline-block around `children` with a line in `color` (default `accent`), `thickness` px (default 8 × unit), through its vertical middle at `angle` degrees (default −3), drawn left to right from `at` over `durationFrames` (default 10) with `easings.out`, slightly longer than the box (2% each side). `dim` (default 1, no dimming) is the opacity the children fade to while the line is drawn. The line spans the whole box of `children`: a text block inside must have its own `width` close to its text (a `Pill`, a short `FitText` with `width`), or the line crosses the whole safe width.

Checks: the text inside `CountUp`, `Checklist`, `InputField`, `UICard` (title) and the `InputField` button runs the same checks as `FitText`; `UICard` and `InputField` declare `surface` and the button declares `accent` for the contrast check of text inside them. `ScanLine`, `Flash`, `Strike`'s line and `Glow` are transparent to the contrast check (it sees the real background through them). Nothing here checks the safe area by itself except through its texts.

## How contrast is checked

Text components, `Pill`, `CTAButton` and `Logo` (fallback text) compare their computed text colour with the background found under the centre of their box: first the element's own opaque fill (a pill's colour), then the first layer under that point that either is a motion-kit component declaring its colour (`Backdrop`, an overlay of 0.45 or more, a plate) or is any element with an opaque CSS `background` (alpha 0.85 or more), so a `div` you draw with a palette colour counts. A photo, or an overlay below 0.45, ends the search with "unknown" and no log. The required ratio is `minContrastFor(fontSize)`: 3:1 for text of 36 px or more, 4.5:1 below. Failing logs `low_contrast`. Each distinct problem is logged once per mounted component, and nothing is logged for elements with effective opacity below 0.05.
