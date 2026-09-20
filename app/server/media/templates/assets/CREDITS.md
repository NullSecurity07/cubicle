# What is bundled with the video studio, and under what terms

## Typefaces — five, all SIL Open Font License 1.1

The films set their words in faces that live in `templates/vendor/`, so a render fetches nothing and a founder
with no network still gets a film that looks like itself. All five are published under the
[SIL Open Font License 1.1](https://openfontlicense.org/), which permits redistribution — including bundled
inside software — and commercial use, and requires only that the fonts are not sold on their own and that any
modified version is renamed. None of them is modified here: each is the Latin subset `woff2` that Google Fonts
serves, copied as it came (Playfair Display is the same subset as the variable file `@fontsource-variable/playfair-display`
5.3.0 packages it, one file for every weight).

| file | face | by | used for |
| --- | --- | --- | --- |
| `inter.woff2` | Inter | Rasmus Andersson | body copy in every pack; the display face of `clean`, `sketch` and `brand` |
| `anton.woff2` | Anton | Vernon Adams / Cyreal | the display face of `creator` — a condensed grotesque that shouts |
| `instrument-serif.woff2` | Instrument Serif | Rodrigo Fuenzalida, Jordan Egstad | the display face of `editorial` |
| `playfair-display.woff2` | Playfair Display (variable, 400–900) | Claus Eggers Sørensen | the display face of `documentary`, set at 700: a serif with enough stem to hold over a photograph |
| `space-grotesk.woff2` | Space Grotesk | Florian Karsten | the display and body face of `neon` |

The families are renamed in the page (`Studio Sans`, `Studio Shout`, `Studio Serif`, `Studio Display`, `Studio Tech`) only so that
a wired product's own typeface can be layered in front of them without a name collision; the files themselves are
untouched, which is what the licence is about.

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

## The local video model — what is fetched, and under what terms

Nothing here is bundled either: the Video studio's local b-roll fetches these onto the founder's own machine on
first use (about 5.8 GB, once, into `~/.cache/stage-video-models`, or wherever `STAGE_VIDEO_MODELS` points). The
list, the exact URLs and the expected sizes live in `server/media/local-clips.ts`.

| what | from | licence |
| --- | --- | --- |
| the renderer, `stable-diffusion.cpp` (Vulkan build, `master-874-656a135`) | [leejet/stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp/releases) | MIT |
| the video model, `wan2.1_t2v_1.3B_fp16.safetensors` | [Comfy-Org/Wan_2.1_ComfyUI_repackaged](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged) | Apache-2.0 |
| the words model, `umt5-xxl-encoder-Q3_K_S.gguf` | [city96/umt5-xxl-encoder-gguf](https://huggingface.co/city96/umt5-xxl-encoder-gguf) | Apache-2.0 |
| the fast decoder, `taew2_1.safetensors` | [Kijai/WanVideo_comfy](https://huggingface.co/Kijai/WanVideo_comfy) | none stated on the re-host; upstream [madebyollin/taehv](https://github.com/madebyollin/taehv) is MIT |
| the four-step adapter, `Wan2_1_self_forcing_dmd_1_3B_lora_rank_32_fp16.safetensors` | [Kijai/WanVideo_comfy](https://huggingface.co/Kijai/WanVideo_comfy) | none stated on the re-host; a rank-32 distillation of [Self-Forcing](https://github.com/guandeh17/Self-Forcing), Apache-2.0 |

Two notes on that adapter, because it is the one piece with a question mark over it.

- The **upstream** Self-Forcing project and its weights ([gdhe17/Self-Forcing](https://huggingface.co/gdhe17/Self-Forcing))
  are Apache-2.0, but upstream publishes full `.pt` checkpoints, not the rank-32 `.safetensors` LoRA that
  `stable-diffusion.cpp` can load. The LoRA exists only as a re-host, so upstream was not an option.
- There are two re-hosts of it. `lym00/Wan2.1_T2V_1.3B_SelfForcing_VACE` states **CC-BY-NC-SA-4.0**, which forbids
  commercial use — and a founder's marketing film is commercial, so that one is **not** used. `Kijai/WanVideo_comfy`
  states no licence at all; it is the one fetched, on the reading that a re-host does not narrow the Apache-2.0
  terms of the weights it is derived from. A founder who would rather use a file they have licensed themselves can
  put it at `<models>/loras/wan21_sf_dmd_1_3B_r32.safetensors` before the first run, and nothing is fetched.

Nothing is redistributed by this repository either way: every one of these is fetched from its own host, onto the
founder's own machine, the first time they ask for a clip.

## Talking heads are not made on this machine

The only local route for a talking head is Wav2Lip, whose licence is non-commercial. So there is no local
presenter at all: a `presenter` scene goes to the free Hugging Face Spaces, and when those cannot make it the
scene falls back to the line said over the words.
