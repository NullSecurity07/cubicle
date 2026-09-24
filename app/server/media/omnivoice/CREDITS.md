# OmniVoice

The Voice studio's second engine. Nothing from it is bundled with this repository: the code is installed and the
weights are downloaded onto the founder's own machine, into `app/.cache/omnivoice/`, the first time the engine is
switched on. What is in this folder is ours: `worker.py`, which talks to the model, and the pins.

| Part | Where it comes from | Licence | What it means here |
| --- | --- | --- | --- |
| Code, the `omnivoice` Python package (0.2.1) | https://github.com/k2-fsa/OmniVoice | Apache-2.0 | Free to use for anything. |
| Weights, `k2-fsa/OmniVoice` | https://huggingface.co/k2-fsa/OmniVoice | CC-BY-NC 4.0 | **Anything it says may not be used commercially.** The model card: "The pre-trained model is licensed under the CC-BY-NC due to constraints from its training data (e.g., Emilia)." |
| Audio tokenizer inside the weights (`audio_tokenizer/`) | Boson AI's Higgs Audio 2 tokenizer | Boson Higgs Audio 2 Community License (based on the Meta Llama 3 Community License) | Asks for the line below, and for a separate licence above 100,000 annual active users. |
| Transcriber for a clone with no words given, `openai/whisper-base` | https://huggingface.co/openai/whisper-base | Apache-2.0 | Fetched only the first time a founder clones a recording the studio did not make itself. |

## What the app does about the non-commercial weights

- The engine is off unless the founder switches it on in a Voice studio card or sets `STAGE_OMNIVOICE=1`.
- Every file it makes gets a `<file>.credits.txt` beside it: the licence, and the reference it was cloned or
  designed from. The card marks the file "non-commercial" and says so in its log.
- A film is never read in OmniVoice unless the founder picked it as the film's narrator by hand, and then the
  film's credits say so.
- Only clone a voice you have permission to use. The model's authors forbid unauthorised cloning, impersonation
  and fraud.

## The line the Higgs Audio 2 licence asks for

Built with Higgs Materials licensed from Boson AI USA, Inc., Copyright Boson AI USA, Inc., All Rights Reserved and
Meta Llama 3 licensed under the Meta Llama 3 Community License, Copyright Meta Platforms, Inc., All Rights Reserved.

Checked against the model page and the repository on 24 September 2026.
