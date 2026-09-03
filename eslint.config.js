import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".design/**",
      ".scratch/**",
      "**/dist/**",
      "node_modules/**",
      "out/**",
      "installers/**",
      "installers-invalid-*/**",
      "coverage/**",
      "test-results/**",
      "playwright-report/**",
      "playwright-report-production/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx,cts,mts}"]
  })),
  {
    files: ["**/*.{ts,tsx,cts,mts}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { "checksVoidReturn": false }]
    }
  },
  {
    files: [
      "packages/ui/src/**/*.{ts,tsx}",
      "apps/desktop/src/renderer/fixtures/**/*.test.ts",
      "apps/desktop/src/renderer/features/mock-repository/mock-repository.ts"
    ],
    rules: {
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unused-vars": "off"
    }
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    files: ["**/*.config.ts"],
    extends: [tseslint.configs.disableTypeChecked]
  },
  {
    // Node scripts at the repo root and inside workspaces (e.g.
    // apps/desktop/scripts/build-electron.mjs) run in the Node global scope.
    files: ["**/scripts/**/*.mjs", "scripts/**/*.js", "*.{js,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node
    }
  }
);
