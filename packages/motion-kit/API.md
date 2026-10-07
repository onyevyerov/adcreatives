# `@adc/motion-kit` — how the components behave

This file is read by the model that writes and repairs scene files. It describes what the components of `@adc/motion-kit` actually do at render time: defaults, timings in frames, what each prop changes, and which quality checks each component runs on itself. It deliberately repeats no type signatures (they are in the declarations that follow this file) and no rules of the scene contract (they are in the main brief). When this file and the declarations disagree about a name or a type, the declarations win; when they disagree about behaviour, this file is the one that was written by hand and is more likely right.

All frame numbers below are at 30 fps. "Settled" means the element has reached its final position and opacity to within about 1%.

The exports that are not described here (`ThemeProvider`, `AssetsProvider`, `SceneDurationProvider`, `QaProvider`, `qaLog`, `parseQaLog`, `MusicTrack`, `Sfx`, `TemplateScene`, `templateVariantFor`, `planFont`, `pruneFontInfo`, `useBrand`, `useAssets`, `useSceneDuration`, `buildTheme`) exist for the host composition. They are already set up around every scene. A scene never renders or calls them: a second `ThemeProvider` or `AssetsProvider` inside a scene breaks fonts and asset lookup for everything inside it.

## Theme: `useTheme()`, colours, radii

`useTheme()` returns the brand kit reduced to what a scene needs. `palette` has seven colours: `primary`, `secondary`, `accent`, `background`, `surface`, `textOnDark`, `textOnLight`. `fonts.heading` and `fonts.body` are CSS font-family strings; the fonts are loaded before the scene renders, so text measurement is exact. `motion` is the brand's motion personality (`energetic`, `calm`, `premium`, `playful`) and `density` is `airy`, `balanced` or `dense`.

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
| `highlight` | every word fades in over 8 frames; each `emphasis` word also gets a marker in `accent` that grows from the left between local frames 6 and 18, and the word's colour switches to `readableOn(accent)` at local frame 12. Without `emphasis` it is just a quick fade | 18 frames |
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

## `Backdrop`

`Backdrop` is an `AbsoluteFill` behind everything; render it first in the tree. `color` defaults to `theme.palette.background` and is the base of `solid`, `noise` and `shapes`.

- `solid`: one flat colour.
- `gradient`: a linear gradient through `colors` (default `primary → secondary`) at `angle` degrees (default 160). `animate` turns the angle by 0.12° per frame, about 18° over a 150-frame scene: slow but visible.
- `noise`: the base colour with a fine monochrome grain at 16% in multiply blend and a soft vignette darkening the edges; `animate` drifts the grain.
- `shapes`: the base colour with five large blurred circles (radius 28–58% of the short side) in fixed pseudo-random positions, coloured in turn from `colors` (default `primary`, `secondary`, `accent`) at 22% opacity; `animate` drifts them by up to 4% of the short side on slow sine curves. The positions are the same in every scene and every video, so two `shapes` backdrops in a row look identical.

For the contrast check a `Backdrop` reports its base colour (`gradient` reports the average of its stops), so text on a gradient from a light to a dark colour may pass the check at the centre and still be hard to read at one end; pick text colours against the actual stop the text sits on.

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

## How contrast is checked

Text components, `Pill`, `CTAButton` and `Logo` (fallback text) compare their computed text colour with the background found under the centre of their box: first the element's own opaque fill (a pill's colour), then the first layer under that point that either is a motion-kit component declaring its colour (`Backdrop`, an overlay of 0.45 or more, a plate) or is any element with an opaque CSS `background` (alpha 0.85 or more), so a `div` you draw with a palette colour counts. A photo, or an overlay below 0.45, ends the search with "unknown" and no log. The required ratio is `minContrastFor(fontSize)`: 3:1 for text of 36 px or more, 4.5:1 below. Failing logs `low_contrast`. Each distinct problem is logged once per mounted component, and nothing is logged for elements with effective opacity below 0.05.
