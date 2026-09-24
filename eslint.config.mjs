// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/", "dist-tests/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Type-aware rules for the server source. These need the TypeScript program,
  // so they only apply to files tsconfig.json actually covers. The payoff is
  // no-floating-promises: every tool handler and every client call here is
  // async, and a dropped promise is a swallowed rejection — a silent wrong
  // answer rather than a crash. Enabling this found nothing outstanding (one
  // false positive, see require-await below), so it is a guard for the future,
  // not a cleanup.
  //
  // src/__tests__ is deliberately excluded: node:test's `test()` returns a
  // promise that is idiomatically not awaited (179 findings, all noise), and
  // its JSON.parse-heavy fixtures trip the no-unsafe-* family for no benefit.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/__tests__/**"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Off on purpose. It fires on server.ts's `start()`, which is async with
      // no await — and that `async` is load-bearing: index.ts calls
      // `start().catch(...)`, so the keyword is what turns a synchronous throw
      // (e.g. loadConfig() rejecting a malformed ANILIST_GRAPHQL_URL) into a
      // rejection that handler can catch. Confirmed live: without it the error
      // would escape before .catch() is attached. The rule cannot see that.
      "@typescript-eslint/require-await": "off",
    },
  },
  // Node build/test scripts: expose Node globals (process, etc.).
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  // Must be last: disables ESLint rules that conflict with Prettier.
  prettier,
);
