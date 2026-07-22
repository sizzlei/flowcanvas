// (Unused.) Storage/persistence is handled client-side via @forge/bridge
// requestConfluence in src/forge-glue.js and src/forge-view.js — attachments
// on the page hold the diagram YAML and the rendered PNG. No resolver needed.
//
// If you prefer a backend resolver (e.g. to enforce server-side logic), add a
// `function` module + `resolver` back to manifest.yml and implement it here.
export {};
