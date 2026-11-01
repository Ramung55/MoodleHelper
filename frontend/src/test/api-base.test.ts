import { apiBase, LOCAL_BACKEND, PAGES_ORIGIN } from "../services/api-base";
import { navPath } from "../components/mh/AppShell";
import { approved } from "../../../shared/src/bridge";

test("only the approved Pages origin talks to the loopback backend directly", () => {
  expect(apiBase(PAGES_ORIGIN)).toBe(LOCAL_BACKEND);
  expect(apiBase("http://127.0.0.1:5173")).toBe("");
  expect(apiBase("https://ramung55.github.io.evil.example")).toBe("");
  expect(apiBase(undefined)).toBe("");
});

test("the Pages origin is approved for the bridge, but not lookalikes", () => {
  expect(approved("https://ramung55.github.io")).toBe(true);
  expect(approved("http://ramung55.github.io")).toBe(false);
  expect(approved("https://evil.github.io")).toBe(false);
});

test("static-host trailing slashes still match shell routes", () => {
  expect(navPath("/deadlines/")).toBe("/deadlines");
  expect(navPath("/deadlines")).toBe("/deadlines");
  expect(navPath("/")).toBe("/");
});
