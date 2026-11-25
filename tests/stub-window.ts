// Lets a unit test import UI modules that touch `window` when they load (src/ui/api.ts adds its error
// listeners): import this first. Nothing else of a browser is pretended.
const g = globalThis as any;
g.window ??= { addEventListener() {}, removeEventListener() {} };
export {};
