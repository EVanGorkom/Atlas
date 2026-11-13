// Gives the bundled tests the browser globals the conversion code expects.
import { JSDOM } from "jsdom";

const { window } = new JSDOM("");
Object.assign(globalThis, { DOMParser: window.DOMParser });
