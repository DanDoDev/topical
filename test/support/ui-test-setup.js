import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });

Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  self: { configurable: true, value: dom.window }
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

for (const name of Object.getOwnPropertyNames(dom.window)) {
  if (name in globalThis) continue;
  const descriptor = Object.getOwnPropertyDescriptor(dom.window, name);
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
}
