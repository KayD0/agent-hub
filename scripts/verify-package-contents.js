const { execFileSync } = require("node:child_process");
const path = require("node:path");

const vsce = path.join(process.cwd(), "node_modules", "@vscode", "vsce", "vsce");
const output = execFileSync(process.execPath, [vsce, "ls"], { encoding: "utf8" });
const files = output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
const allowed = ["README.md", "package.json", "media/", "dist/src/", "node_modules/"];
const forbidden = files.filter((file) => !allowed.some((prefix) => file === prefix || file.startsWith(prefix)));
const required = ["package.json", "README.md", "dist/src/extension.js", "media/agenthub.svg"];
const missing = required.filter((file) => !files.includes(file));
if (forbidden.length || missing.length) {
  if (forbidden.length) process.stderr.write(`許可されていないVSIX内容:\n${forbidden.join("\n")}\n`);
  if (missing.length) process.stderr.write(`VSIXに必要なファイルがありません:\n${missing.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`VSIX内容を検証しました（${files.length} files）。\n`);
