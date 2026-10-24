/**
 * The MIT License (MIT)
 * Copyright (c) 2017-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

const colors = require('colors');
const shell = require('shelljs');

// Whether we're in the watch mode (continuous JS code transpiling).
const watchMode = process.argv[2] || '';

let watchMsg = '';
if (watchMode) {
  watchMsg = ` (watch mode)`;
}

// A build that prints "All done" while producing no artifacts is worse than a
// build that fails loudly: `index.js` requires `./dist/regexp-tree`, so a silent
// no-op leaves every consumer with MODULE_NOT_FOUND and a green exit code.
function runOrExit(command, options) {
  const result = shell.exec(command, options);

  if (result.code !== 0) {
    console.error(
      colors.red(`\nBuild step failed (exit ${result.code}): ${command}\n`)
    );
    shell.exit(1);
  }

  return result;
}

// Git hooks are a convenience for contributors. Installing a symlink fails on
// Windows unless the process is elevated (or Developer Mode is on), and that
// failure must never abort a build.
function installHook(name, source) {
  console.info(`  - ${name}: .git/hooks/${name}`);

  shell.exec(`unlink .git/hooks/${name}`, { silent: true });
  shell.chmod('+x', `./${source}`);

  const result = shell.ln('-s', `../../${source}`, `.git/hooks/${name}`);

  if (result.code !== 0) {
    const reason = (result.stderr || '').trim().split('\n')[0];
    console.warn(
      colors.yellow(`    skipped: symlink not permitted${reason ? ` (${reason})` : ''}`)
    );
  }
}

console.info(colors.bold(`Building${watchMsg}...\n`));

// ----------------------------------------------------------
// Rebuild parser.

console.info(colors.bold('[1/3] Generating parser module...\n'));

runOrExit(
  `node node_modules/syntax-cli/bin/syntax -g src/parser/regexp.bnf -o src/parser/generated/regexp-tree.js -m lalr1 --loc`
);

// ----------------------------------------------------------
// Git hooks.

console.info(colors.bold('[2/3] Installing Git hooks...\n'));

installHook('pre-commit', 'scripts/git-pre-commit');
installHook('pre-push', 'scripts/git-pre-push');

console.info('');

// ----------------------------------------------------------
// Transform code for older Node versions.
//
// The inline `NODE_ENV=production cmd` form used previously is a POSIX shell
// feature: cmd.exe parses it as "run a command named NODE_ENV", so the
// transpiler never starts. Pass the variable through the child environment
// instead, which works on every platform. `.babelrc` only defines presets under
// `env.production`, so this variable is what actually enables transpilation.

console.info(colors.bold('[3/3] Transpiling JS code...\n'));

runOrExit(
  `node node_modules/babel-cli/bin/babel.js ${watchMode} src/ --out-dir dist/ --ignore __tests__`,
  { env: Object.assign({}, process.env, { NODE_ENV: 'production' }) }
);

if (!watchMode && !shell.test('-f', 'dist/regexp-tree.js')) {
  console.error(colors.red('\nBuild finished without dist/regexp-tree.js.\n'));
  shell.exit(1);
}

console.info(colors.bold('\nAll done.\n'));
