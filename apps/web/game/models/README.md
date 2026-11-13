# Player model

`private-military-contractor.fbx` is the source model for other players (Mixamo skeleton, SCAR-17).
`public/models/operator.glb` is built from it:

1. `convert.html` + `convert.cjs` (run with a static server in this folder and three@0.180 installed):
   removes the smoke/photo cards, shell casings and loose magazines, welds vertices, pins the rifle to
   the right hand and the pouches to the chest bone, scales to metres (1.80 m), puts the feet at y = 0
   and turns the model to face -Z (the game's forward).
2. `npx @gltf-transform/cli simplify operator.glb op.glb --ratio 0.35 --error 0.002`
   then `npx @gltf-transform/cli quantize op.glb operator.glb` (78k -> 41k triangles, 3.5 MB -> 1.4 MB).

Materials are not in the file: `src/game/operator.ts` maps each part (body, vest, helmet, goggles,
gloves, boots, scar...) to the original game's PBR material library.

**Licence:** the source was found with mesh names pointing at desirefx.me. Confirm the original
author's licence allows use in a published game before shipping it publicly, and credit them.
