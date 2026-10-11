// Preloaded with --import: installs the resolve hook that swaps in the
// stand-in SDK for the process it is loaded into.
import { register } from "node:module";

register("./resolve-hook.mjs", import.meta.url);
