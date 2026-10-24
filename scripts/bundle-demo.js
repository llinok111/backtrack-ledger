#!/usr/bin/env node
/**
 * Bundles `src/` into a single browser script.
 *
 * The library has no runtime dependencies and every import is relative, so a
 * full module resolver is unnecessary. This walks the require graph, wraps each
 * file in a CommonJS shim, and emits one IIFE that exposes
 * `window.regexpTree`.
 *
 * Deliberately not a general-purpose bundler: no plugins, no code splitting, no
 * source maps. Its only job is to make the workbench runnable from `file://`.
 *
 * The MIT License (MIT)
 * Copyright (c) 2017-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = 'src/regexp-tree.js';

const modules = new Map();

function normalize(id) {
  return id.split(path.sep).join('/');
}

function resolveFile(fromId, request) {
  const fromDir = path.posix.dirname(normalize(fromId));
  const base = path.posix.normalize(path.posix.join(fromDir, request));

  const candidates = [
    `${base}.js`,
    `${base}/index.js`,
    base,
  ];

  for (const candidate of candidates) {
    const absolute = path.join(ROOT, candidate);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      return normalize(path.relative(ROOT, absolute));
    }
  }

  throw new Error(`Cannot resolve "${request}" from "${fromId}"`);
}

function collect(id) {
  if (modules.has(id)) {
    return;
  }

  const source = fs.readFileSync(path.join(ROOT, id), 'utf8');
  const dependencies = [];
  const pattern = /require\(\s*'([^']+)'\s*\)/g;
  let match = pattern.exec(source);

  while (match) {
    const request = match[1];

    if (request.startsWith('.')) {
      dependencies.push({request, resolved: resolveFile(id, request)});
    } else {
      throw new Error(
        `Bare import "${request}" in ${id}: the bundle must stay dependency-free.`
      );
    }

    match = pattern.exec(source);
  }

  modules.set(id, {source, dependencies});

  for (const dependency of dependencies) {
    collect(dependency.resolved);
  }
}

function build() {
  collect(ENTRY);

  const parts = [];

  parts.push('(function (global) {');
  parts.push("  'use strict';");
  parts.push('  var modules = {};');
  parts.push('  var cache = {};');
  parts.push('');
  parts.push('  function define(id, factory) {');
  parts.push('    modules[id] = factory;');
  parts.push('  }');
  parts.push('');
  parts.push('  function requireFrom(id) {');
  parts.push('    if (cache[id]) {');
  parts.push('      return cache[id].exports;');
  parts.push('    }');
  parts.push('');
  parts.push('    var module = { exports: {} };');
  parts.push('    cache[id] = module;');
  parts.push('    modules[id](module, module.exports, requireFrom);');
  parts.push('    return module.exports;');
  parts.push('  }');

  for (const [id, {source, dependencies}] of modules) {
    const map = dependencies
      .map((dependency) => `      ${JSON.stringify(dependency.request)}: ${JSON.stringify(dependency.resolved)},`)
      .join('\n');

    parts.push('');
    parts.push(`  define(${JSON.stringify(id)}, function (module, exports, __require) {`);
    parts.push('    var __map = {');
    parts.push(map);
    parts.push('    };');
    parts.push('    function require(request) {');
    parts.push('      return __require(__map[request] || request);');
    parts.push('    }');
    parts.push('');
    parts.push(source);
    parts.push('  });');
  }

  parts.push('');
  parts.push(`  global.regexpTree = requireFrom(${JSON.stringify(ENTRY)});`);
  parts.push(
    '})(typeof window !== "undefined" ? window : globalThis);'
  );

  return parts.join('\n');
}

const output = process.argv[2];

if (!output) {
  console.error('Usage: node scripts/bundle-demo.js <output.js>');
  process.exit(1);
}

fs.writeFileSync(output, build(), 'utf8');

const size = fs.statSync(output).size;
console.log(`bundled ${modules.size} modules -> ${output} (${(size / 1024).toFixed(1)} KB)`);
