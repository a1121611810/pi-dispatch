import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/index.ts",
  platform: "node",
  // pi 由宿主提供（peerDependency），不能打进产物
  external: [/^@earendil-works\//],
  output: {
    file: "dist/index.js",
    format: "esm",
  },
});
