import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom does not implement scrollTo; the router calls it on navigation.
window.scrollTo = () => {};

afterEach(() => {
  cleanup();
});
