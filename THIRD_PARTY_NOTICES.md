# Third-party assets

Font licenses and trademark rights are separate from this repository's source.

## Fonts

Instrument Sans and JetBrains Mono are variable fonts under the SIL Open Font License 1.1. They ship in `web/public/fonts` with their license files, so the page never loads a font from the network.

| File | Family | Used for | License |
|---|---|---|---|
| `InstrumentSans.ttf` | Instrument Sans, weights 400 to 700 | all interface text | `OFL-InstrumentSans.txt` |
| `JetBrainsMono.ttf` | JetBrains Mono, weights 100 to 800 | model ids, numbers, code | `OFL-JetBrainsMono.txt` |

## Logos

The Akamai logos in `web/public/brand` are trademarks of Akamai Technologies. This repository does not grant trademark rights. Keep their proportions and colors.

## PDF.js

The Playground uses Mozilla's PDF.js parser and worker to extract text from PDF attachments in the browser. Copyright 2024 Mozilla Foundation. The frontend includes a copy of the [Apache License 2.0](web/public/licenses/PDFjs-LICENSE.txt).

## Models

The app calls models hosted by Akamai Inference. Each model has its own license and terms. No model weights are in this repository.

## Website prompts

Some build prompts name a well-known product as a style reference, for example "Netflix-style". Each of those prompts tells the model to use an original name and original artwork.
