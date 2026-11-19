import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { installMatchMedia, setViewportWidth } from "./viewport";

installMatchMedia();

beforeEach(() => {
  setViewportWidth(1280);
});

afterEach(() => {
  cleanup();
});
