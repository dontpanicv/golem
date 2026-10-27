#!/bin/sh
# Downloads Parakeet Ultra (Core ML, ~630 MB), the speech model the app bundles for dictation, into ios/Models (not in
# git), and checks every file against its pinned hash. The build copies it into the app; without it, there is no
# dictation. Moondream's post-training of NVIDIA's Parakeet TDT 0.6B v3 (CC-BY-4.0), in 25 European languages, Czech
# and English among them; Core ML conversion by FluidInference: https://huggingface.co/FluidInference/parakeet-ultra-coreml
set -eu
REPO=FluidInference/parakeet-ultra-coreml
REVISION=95eaa59a39d4394f047a4dc5cce480388a60d1b6
DEST="$(cd "$(dirname "$0")/.." && pwd)/Models/parakeet-ultra"
[ -f "$DEST/REVISION" ] && [ "$(cat "$DEST/REVISION")" = "$REVISION" ] && exit 0

# path, then its hash: sha256 for large files, the git blob id for small ones (as Hugging Face lists them).
FILES="
Preprocessor.mlmodelc/analytics/coremldata.bin c9beeb989c8d66f8be11df59bc6df277ec76cee404f6865b46243835ef562f6d
Preprocessor.mlmodelc/coremldata.bin dbde3f2300842c1fd51ef3ff948a0bcffe65ffd2dca10707f2509f32c1d65b1d
Preprocessor.mlmodelc/metadata.json 06162c58cf2f5343a0e60f36f843bcdf3cc58527
Preprocessor.mlmodelc/model.mil f987e2479228436c49189aa47edb376db74dcff5
Preprocessor.mlmodelc/weights/weight.bin 129b76e3aeafa8afa3ea76d995b964b145fe83700d579f6ff42c4c38fa0968ea
Encoder.mlmodelc/analytics/coremldata.bin d87101d824d6723cf95304da33755c3c60e762663b9ef2b0c4bd0aa166a09a0d
Encoder.mlmodelc/coremldata.bin 397a84a4062f563cbc5f56077c674f09a61d85be5090f61d2f1932afb92ac0fe
Encoder.mlmodelc/model.mil 8c5c9915fc71bb7e9b0be1e7b55e38ec6a007e7f
Encoder.mlmodelc/weights/weight.bin 315ba01f33cadbf601d43ac7f5c86208b7aa75fdaa34705c9869d5abe3521c9b
Decoder.mlmodelc/analytics/coremldata.bin fe92b6cfaa012abd5248c0bc877832f19807015abffc60d87b8ccc8ccb48b3b5
Decoder.mlmodelc/coremldata.bin 3b06e66768f0df7e21795f50e2b29300e33eeb1a2579dc42c695279c2d308497
Decoder.mlmodelc/model.mil 36dcd5cbb71d13f42a177427ddbab7539e0d167e
Decoder.mlmodelc/weights/weight.bin 02a0d219f281b9665bc10c8768649403b2eebbbf4b44c627041d948e0de11bb4
JointDecisionv3.mlmodelc/analytics/coremldata.bin 68d38ca646aebafa7a9329e2efda50f5767c49e89fdb5f77f212072bb66f97c4
JointDecisionv3.mlmodelc/coremldata.bin 5e3af5a4ce686f6c237cadbd9284e10d333bc0e1546633cd0e430e6194044bc4
JointDecisionv3.mlmodelc/model.mil be552d46f98f9dc9b242b0d1659833db60aa3f83
JointDecisionv3.mlmodelc/weights/weight.bin 3f310b85b82341c53ec383025ab094a4e462ee1c592e1ad7c6bfe39cff66ca25
parakeet_vocab.json c684822ec3b671ebc449c433a7012398d39b8bb0
README.md a166d3e4fdaa2a42338309881c41b5ab4ca50b10
"
echo "$FILES" | while read -r file hash; do
  [ -n "$file" ] || continue
  target="$DEST/model/$file"
  if [ ! -s "$target" ]; then
    mkdir -p "$(dirname "$target")"
    echo "fetching $file"
    curl -fL --retry 3 -sS -o "$target.part" "https://huggingface.co/$REPO/resolve/$REVISION/$file"
    mv "$target.part" "$target"
  fi
  if [ ${#hash} = 64 ]; then have="$(shasum -a 256 "$target" | cut -d' ' -f1)"; else have="$(git hash-object "$target")"; fi
  if [ "$have" != "$hash" ]; then
    mv "$target" "$target.bad"
    echo "error: $file doesn't match its pinned hash (moved aside as $file.bad)" >&2
    exit 1
  fi
done

echo "$REVISION" > "$DEST/REVISION"
du -sh "$DEST/model"
