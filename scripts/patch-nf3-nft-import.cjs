// Patches nf3's vendored trace.mjs to use a default import for "@vercel/nft".
// @vercel/nft ships as CommonJS, and some copies of it (including the one
// nf3 bundles under its own dist/node_modules) are minified in a way that
// Node's cjs-module-lexer fails to statically detect named exports from.
// That makes `import { nodeFileTrace } from "@vercel/nft"` throw at runtime.
// A default import always works for CJS interop, so we rewrite the import
// to destructure `nodeFileTrace` off the default export instead.
const fs = require("node:fs");
const path = require("node:path");

const targetPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "nf3",
  "dist",
  "_chunks",
  "trace.mjs",
);

if (!fs.existsSync(targetPath)) {
  process.exit(0);
}

const source = fs.readFileSync(targetPath, "utf8");
const namedImport = 'import { nodeFileTrace } from "@vercel/nft";';

if (!source.includes(namedImport)) {
  process.exit(0);
}

const patched = source.replace(
  namedImport,
  'import __vercelNft from "@vercel/nft";\nconst { nodeFileTrace } = __vercelNft;',
);

fs.writeFileSync(targetPath, patched);
console.log("[patch-nf3-nft-import] Patched nf3's @vercel/nft import for CJS/ESM interop.");
