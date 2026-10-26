export default {
  test: {
    environment: "node",
    globals: true,
    include: ["browser-workspace/smoke.test.ts", "browser-workspace/extension-shell.test.ts"],
  },
};
