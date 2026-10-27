#!/bin/sh
# Downloads Supertonic-3 (Supertone, BigScience Open RAIL-M; Core ML conversion by FluidInference), the voice Golem
# speaks with in a conversation, in Czech and English, into ios/Models (not in git), and checks every file against its
# pinned hash. ~170 MB: the four models (the Neural Engine's int4 vector estimators), their tables and the ten voices.
# The build copies it into the app; without it there is no conversation mode. The license has use restrictions, and
# its copy goes into the app with the model. https://huggingface.co/FluidInference/supertonic-3-coreml
set -eu
REPO=FluidInference/supertonic-3-coreml
REVISION=2b5b939dfa1bca362c5212dcafeb8aadde90b1bc
DEST="$(cd "$(dirname "$0")/.." && pwd)/Models/supertonic-3"
[ -f "$DEST/REVISION" ] && [ "$(cat "$DEST/REVISION")" = "$REVISION" ] && exit 0

# path, then its hash: sha256 for large files, the git blob id for small ones (as Hugging Face lists them).
FILES="
LICENSE 1e2cbe6cef94c8cdf3ed1fcebc0f5317ca7ad5a1
tts.json 28575b0793c92607a0f0a292550df9bd17709a79
unicode_indexer.json 3aaf4d33024aff0be455633c24b3636b3a810150
TextEncoder_v2.mlmodelc/analytics/coremldata.bin 973b90afda5d837c037cef2dcbbda275f005eeeb55f2712ca6fbcfa68220f5b5
TextEncoder_v2.mlmodelc/coremldata.bin c1177e3e03cc4130e5dca18eb007f20573bf95d3938abf62ab2d3470b04cbe7f
TextEncoder_v2.mlmodelc/model.mil 26a3afd70795027bf7d7df32acddba93e33953f5
TextEncoder_v2.mlmodelc/weights/weight.bin 7c7afa5d02426a8a363c9cef0e27ce64a5c57a67d1a59f60aac0ac58ffb9877f
DurationPredictor_v2.mlmodelc/analytics/coremldata.bin d8bfa7996e1b4c0e26c9c1edc3861f28726bbd30f74d4a7519e69ef78c1b2d1c
DurationPredictor_v2.mlmodelc/coremldata.bin f4f1630670632dd149787fb6ea4f934ab915c390a88d87a4e825ca58f041b4b2
DurationPredictor_v2.mlmodelc/model.mil 0b73a6a022dc31a198c17e2edca1538f8414885b
DurationPredictor_v2.mlmodelc/weights/weight.bin 7f709c544087966d6b2538ac50b7a4014d6e1049e21d713cf3bc71c4c5b9307c
VectorEstimatorVariants/VectorEstimator_v2_L128_int4.mlmodelc/analytics/coremldata.bin d86b6a6763b342d1e4921ea055e6dfbad082f76643d1a403cce66d2aa2974a2c
VectorEstimatorVariants/VectorEstimator_v2_L128_int4.mlmodelc/coremldata.bin 2e3b78de95e365609e870fe6af76c5f5e87c1a6787871cf3954d445af085f85f
VectorEstimatorVariants/VectorEstimator_v2_L128_int4.mlmodelc/model.mil af791ab8b5e7906bfbbbd619379424048d62b069
VectorEstimatorVariants/VectorEstimator_v2_L128_int4.mlmodelc/weights/weight.bin c6173731642fd2eb40f759a970d4cdea459c0368cc37a29d0b4c1d19fd1ca90a
VectorEstimatorVariants/VectorEstimator_v2_L256_int4.mlmodelc/analytics/coremldata.bin 80775fe9f4b06a17dd7ac9454daf62181ac260df24f4e197bd1a9914d0ba24db
VectorEstimatorVariants/VectorEstimator_v2_L256_int4.mlmodelc/coremldata.bin 7cb6db0a28a0efa6e50248f9ecdb07b4ae8a7e078873eadb2a87f476a310d758
VectorEstimatorVariants/VectorEstimator_v2_L256_int4.mlmodelc/model.mil a636ec02d75b1cea9d92fed73b21607bf76a7f3f
VectorEstimatorVariants/VectorEstimator_v2_L256_int4.mlmodelc/weights/weight.bin e9574dcce25fd7d3f4a68b2257f74fea5227ccd9e6843d53f0e9f5476aa8dc87
VectorEstimatorVariants/VectorEstimator_v2_L512_int4.mlmodelc/analytics/coremldata.bin 439f6850aff99365baae7651e0859e65fde08280fbb6ddb18a7d6fc5cc905d31
VectorEstimatorVariants/VectorEstimator_v2_L512_int4.mlmodelc/coremldata.bin d8f370e473dafa80fdb00ba827eb87b46b123e5fab8c7c41f7e014140c4d9fce
VectorEstimatorVariants/VectorEstimator_v2_L512_int4.mlmodelc/model.mil 06471e32e07cb206c3bb40bd035156ea5d89c59f
VectorEstimatorVariants/VectorEstimator_v2_L512_int4.mlmodelc/weights/weight.bin 75621d8dcab2fb486fcf7424bf44f472c84f55fdabe5b9b9a5fa781447c7a860
Vocoder.mlmodelc/analytics/coremldata.bin 4fe1b825137629a96dc58a1339bc4ece32041b755f99d638f21a153f2e7faed6
Vocoder.mlmodelc/coremldata.bin dbf54fc98879ee1c9a213452e16d09367f3c34ad489b175bcae7ef5f74f8d121
Vocoder.mlmodelc/model.mil 34a4ffeca5ce8725b9f0cd2a55b061ade408cc81
Vocoder.mlmodelc/weights/weight.bin b45e4c17a45cc4de30dcedae9f662548aa35f8f9763632c342b8bbef3089fcee
voice_styles/F1.json 421365f307ed1535d8da16845031d0e9fa3e60c5
voice_styles/F2.json b09a3a433df8a4856d1d7d64736a56ddf37a4ea3
voice_styles/F3.json a366f94c77c4b440404071f1a52bed3ccf83a5ff
voice_styles/F4.json 39c78a52795320c6101b7eaf984c0e2352fbdc18
voice_styles/F5.json 06983f8816ad00a8eeb7efd37a33d457587e16f8
voice_styles/M1.json bddfff85a7c4c140c11620bd7005d86681dccdac
voice_styles/M2.json 602ff6c4d6d48cdb71c37461f7c175d71fe8b34b
voice_styles/M3.json 000b60436b77619b933fdc33628ad737595e6794
voice_styles/M4.json aae253ae81185fa06a6469c3f1cdff04ed121ddf
voice_styles/M5.json 0536b252698830f8536c077edcb94e1ce4768ab6
"
# FluidAudio finds the files in this folder (Repo.supertonic3.folderName); elsewhere it downloads them again.
MODEL="$DEST/model/supertonic-3"
echo "$FILES" | while read -r file hash; do
  [ -n "$file" ] || continue
  target="$MODEL/$file"
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
