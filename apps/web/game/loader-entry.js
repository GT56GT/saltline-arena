// Bundled into public/saltline/loader.js. `three` resolves to the THREE instance inside the
// original game (window.__G.THREE, r180), so loaded models live in the renderer's own realm.
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
window.__arenaLoaders = { GLTFLoader, SkeletonUtils };
