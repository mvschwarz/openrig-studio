// ESLint flat config: the recommended rules, Node globals for the server and
// tools, browser globals for the shell's modules, and nothing that conflicts
// with Prettier, which owns formatting.
import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  { ignores: ["**/node_modules/", "**/.runtime/"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
  },
  {
    rules: {
      // An empty catch is how this code says "this failure is expected and harmless".
      "no-empty": ["error", { allowEmptyCatch: true }],
      // `const { a, ...rest } = x` is the idiom for dropping a field.
      "no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["app/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    // Several tests match source indentation as text, where literal spaces read
    // more plainly than a {n} count.
    files: ["test/**/*.mjs", "create-studio/test/**/*.mjs"],
    rules: { "no-regex-spaces": "off" },
  },
  prettier,
];
