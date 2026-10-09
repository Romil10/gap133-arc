// Build the Claude Desktop extension: bundle mcp/server.mjs and its dependencies
// into one file, then pack extension/ into public/gap133.mcpb.
//   node scripts/build-extension.mjs   (needs: npm i --no-save esbuild @anthropic-ai/mcpb)
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const mcpb = 'node_modules/@anthropic-ai/mcpb/dist/cli/cli.js';

const version = JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version;
// The icon is stored as base64 text so the repo stays text-only.
writeFileSync('extension/icon.png', Buffer.from(readFileSync('extension/icon.png.b64', 'utf8'), 'base64'));

await build({
  entryPoints: ['mcp/server.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  minify: true,
  legalComments: 'none',
  outfile: 'extension/server/index.mjs',
  banner: { js: `// gap133 on Arc MCP server ${version}, bundled. Source: https://github.com/Romil10/gap133-arc/tree/main/mcp\nimport { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);` },
});
execFileSync(process.execPath, [mcpb, 'validate', 'extension/manifest.json'], { stdio: 'inherit' });
execFileSync(process.execPath, [mcpb, 'pack', 'extension', 'public/gap133.mcpb'], { stdio: 'inherit' });
