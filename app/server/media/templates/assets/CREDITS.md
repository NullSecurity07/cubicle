# What is bundled with the video studio, and under what terms

## Sound effects — Kenney, CC0 1.0 (public domain)

The ten files in `sfx/` come from [Kenney](https://kenney.nl/)'s free game-asset packs, which Kenney releases
under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/): no rights reserved, no
attribution required, free to redistribute and to use commercially. They were converted from
Ogg Vorbis to 44.1 kHz mono 16-bit WAV with `ffmpeg`, which changes nothing about their terms.

| file | from | used for |
| --- | --- | --- |
| `cut-soft.wav` | `impact/impactSoft_medium_001.ogg` | the cut into a new scene, calm pace |
| `cut-hard.wav` | `impact/impactSoft_heavy_002.ogg` | the cut into a new scene, punchy pace |
| `cut-wood.wav` | `impact/impactWood_medium_003.ogg` | the cut into a footage or device scene |
| `accent-bong.wav` | `interface/bong_001.ogg` | a figure landing on a stat scene |
| `tick.wav` | `interface/click_003.ogg` | each line of a list or a set of steps arriving |
| `switch.wav` | `interface/switch_002.ogg` | the turn in a compare scene |
| `drop.wav` | `interface/drop_001.ogg` | a logo sting |
| `select.wav` | `interface/select_008.ogg` | a checklist mark |
| `rollover.wav` | `ui/rollover2.ogg` | a soft accent under a hook |
| `glitch.wav` | `interface/glitch_002.ogg` | a hard opener, punchy pace only |

Kenney asks, but does not require, that projects credit him. This file is that credit, and the founder is
welcome to put it in a film's description too.

## Music — nothing is bundled, on purpose

The same `brag` plugin bundles five tracks from [ende.app](https://ende.app/en) ("Happy Beats / Business
Moves"). Its own `assets/music/README.md` ends with:

> Before publishing or redistributing the skill, verify and document the exact music license terms alongside
> these files.

So the terms are, by the bundler's own admission, unverified: the plugin's MIT licence covers the plugin's
code, not third-party audio inside it, and nothing in the repository or on ende.app that could be read from
here states a redistribution grant. Copying those files into this app would be redistributing music under
terms nobody has established, so they were **not** copied.

The `music` field on a storyboard is still there and still means something: it is the mood the film wants. The
bed itself is a file **the founder drops on the Video studio card** — their own track, or one they have
licensed. When a film asks for music and the card holds no audio asset, the render says so in plain words on
the card and makes the film without a bed.
