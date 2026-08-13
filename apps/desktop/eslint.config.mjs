import baseConfig from "../../eslint.config.mjs";

export default [
  ...baseConfig,
  {
    ignores: [
      "analysis/dist/**",
      "capture/dist/**",
      "direct/dist/**",
      "frontend/dist/**",
      "runtime/dist/**",
      "zig-out/**",
    ],
  },
];
