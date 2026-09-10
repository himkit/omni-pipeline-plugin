/**
 * Plugin entry — exports the plugin and nothing else.
 *
 * opencode's loader walks every export of a plugin module, requires each one to
 * be a function, and calls each with the plugin input. The helpers in omni.ts
 * exist for the tests; called as plugins they throw, the whole module is logged
 * as "failed to load plugin", and every export after the throw never runs. That
 * the gatekeeper armed at all was an accident of ordering: ESM namespace keys
 * are alphabetical, so `OmniPlugin` (capital O) happened to be reached first.
 */
export { OmniPlugin } from "./omni.ts"
