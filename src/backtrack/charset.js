/**
 * Character-level matching for the backtracking engine.
 *
 * Every predicate here answers a single question: does this one UTF-16 code unit
 * belong to the set described by the AST node? Multi-code-unit handling (`u`/`v`
 * flags) is rejected upstream in `analyze.js`, so a code unit is the finest unit
 * this engine ever sees.
 *
 * The MIT License (MIT)
 * Copyright (c) 2017-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

'use strict';

// Single-character probes delegate to the native engine so that `\s`, `\w` and
// friends keep exactly the semantics of the running JavaScript engine instead of
// a hand-copied table that would drift.
const META_PROBES = {
  '\\d': /^[0-9]$/,
  '\\D': /^[^0-9]$/,
  '\\w': /^[A-Za-z0-9_]$/,
  '\\W': /^[^A-Za-z0-9_]$/,
  '\\s': /^\s$/,
  '\\S': /^\S$/,
};

const DOT = /^.$/;
const DOT_ALL = /^.$/s;

const ASCII_ONLY = /^[\x00-\x7f]$/;

/**
 * Folds a single code unit for case-insensitive comparison.
 *
 * Restricting folding to ASCII keeps the behaviour exactly aligned with the
 * native engine for the character sets this tool targets. Non-ASCII case folding
 * differs per Unicode version, so `analyze.js` reports it as a limitation
 * instead of guessing.
 */
function fold(unit) {
  return unit >= 'A' && unit <= 'Z' ? unit.toLowerCase() : unit;
}

function isMetaChar(node, unit, flags) {
  const value = node.value;

  if (value === '.') {
    return flags.dotAll ? DOT_ALL.test(unit) : DOT.test(unit);
  }

  const probe = META_PROBES[value];
  if (!probe) {
    return false;
  }

  if (flags.ignoreCase && !ASCII_ONLY.test(unit)) {
    // Case folding is skipped for non-ASCII input; see `analyze.js`.
    return probe.test(unit);
  }

  return probe.test(unit);
}

function isClassMember(expressions, unit, flags) {
  for (const expression of expressions) {
    if (expression.type === 'ClassRange') {
      const code = unit.charCodeAt(0);
      const from = expression.from.codePoint;
      const to = expression.to.codePoint;

      if (code >= from && code <= to) {
        return true;
      }

      if (flags.ignoreCase) {
        const folded = fold(unit).charCodeAt(0);
        if (folded >= from && folded <= to) {
          return true;
        }
      }

      continue;
    }

    if (matchesChar(expression, unit, flags)) {
      return true;
    }
  }

  return false;
}

/**
 * Whether `unit` (exactly one UTF-16 code unit) is accepted by `node`.
 */
function matchesChar(node, unit, flags) {
  if (node.type === 'CharacterClass') {
    const inside = isClassMember(node.expressions, unit, flags);
    return node.negative ? !inside : inside;
  }

  if (node.type !== 'Char') {
    return false;
  }

  if (node.kind === 'meta') {
    return isMetaChar(node, unit, flags);
  }

  const code = unit.charCodeAt(0);

  if (node.codePoint != null && code === node.codePoint) {
    return true;
  }

  if (flags.ignoreCase) {
    return fold(unit) === fold(node.symbol != null ? node.symbol : node.value);
  }

  return false;
}

module.exports = {matchesChar, fold};
