/**
 * Compiles a RegExp AST into a flat instruction sequence for the backtracking
 * virtual machine in `vm.js`.
 *
 * A flat program plus an explicit backtrack stack replaces recursive
 * generators. The generator version was correct but ran out of call stack at
 * roughly 5k input characters and spent seconds on linear patterns, which made
 * the ledger unusable for the cases it exists to explain.
 *
 * The MIT License (MIT)
 * Copyright (c) 2017-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

'use strict';

const OP = {
  CHAR: 'CHAR',
  SPLIT: 'SPLIT',
  JMP: 'JMP',
  SAVE: 'SAVE',
  ASSERT: 'ASSERT',
  MARK: 'MARK',
  PROGRESS: 'PROGRESS',
  MATCH: 'MATCH',
};

// Bounded repetition is expanded inline, so `a{1000}` would otherwise emit a
// thousand instructions. Real patterns in this space use small bounds; anything
// larger is refused instead of silently producing a huge program.
const MAX_INSTRUCTIONS = 20000;

class CompileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompileError';
  }
}

function boundOf(quantifier) {
  switch (quantifier.kind) {
    case '?':
      return {min: 0, max: 1};
    case '*':
      return {min: 0, max: Infinity};
    case '+':
      return {min: 1, max: Infinity};
    default:
      return {
        min: quantifier.from,
        max: quantifier.to == null ? Infinity : quantifier.to,
      };
  }
}

/**
 * Whether the node can match the empty string.
 */
function isNullable(node) {
  // An empty alternative branch parses to `null`; it matches the empty string.
  if (!node) {
    return true;
  }

  switch (node.type) {
    case 'RegExp':
      return isNullable(node.body);
    case 'Alternative':
      return node.expressions.every(isNullable);
    case 'Disjunction':
      return isNullable(node.left) || isNullable(node.right);
    case 'Group':
      return isNullable(node.expression);
    case 'Repetition': {
      const {min} = boundOf(node.quantifier);
      return min === 0 || isNullable(node.expression);
    }
    case 'Assertion':
      return true;
    default:
      return false;
  }
}

class Compiler {
  constructor() {
    this.out = [];
    this.markCount = 0;
    this.groupCount = 0;
  }

  emit(instruction) {
    if (this.out.length >= MAX_INSTRUCTIONS) {
      throw new CompileError(
        `Program exceeds ${MAX_INSTRUCTIONS} instructions after expanding ` +
          `bounded quantifiers.`
      );
    }

    this.out.push(instruction);
    return this.out.length - 1;
  }

  nextMark() {
    return this.markCount++;
  }

  /**
   * Emits a greedy or lazy star, guarding against zero-width iterations.
   *
   * `(a*)*` would loop forever if the body consumed nothing and the machine
   * jumped straight back. The native engine stops iterating in that case, so a
   * MARK/PROGRESS pair records the offset on entry and exits the loop when an
   * iteration failed to advance it.
   */
  emitStar(expression, greedy) {
    const loop = this.emit({op: OP.JMP});

    const enter = this.out.length;
    const needsGuard = isNullable(expression);
    let mark = null;
    let progress = -1;

    if (needsGuard) {
      mark = this.nextMark();
      this.emit({op: OP.MARK, slot: mark});
    }

    const split = this.emit({op: OP.SPLIT});
    const body = this.out.length;

    this.compile(expression);

    if (needsGuard) {
      progress = this.emit({op: OP.PROGRESS, slot: mark, target: -1});
    }

    this.emit({op: OP.JMP, target: enter});

    const exit = this.out.length;

    // A zero-width iteration jumps straight to the exit. Re-entering the split
    // would compare the same offset forever.
    if (progress >= 0) {
      this.out[progress].target = exit;
    }

    this.out[split].primary = greedy ? body : exit;
    this.out[split].secondary = greedy ? exit : body;
    this.out[loop].target = enter;

    return {enter, exit};
  }

  emitPlus(expression, greedy) {
    // `X+` where X can match empty is compiled as `X X*`: one mandatory pass,
    // then the guarded loop. Without the split, a zero-width X would jump back
    // to its own start indefinitely.
    if (isNullable(expression)) {
      this.compile(expression);
      this.emitStar(expression, greedy);
      return;
    }

    const body = this.out.length;
    this.compile(expression);

    const split = this.emit({op: OP.SPLIT});
    const exit = this.out.length;

    this.out[split].primary = greedy ? body : exit;
    this.out[split].secondary = greedy ? exit : body;

    return {enter: body, exit};
  }

  compileRepetition(node) {
    const {min, max} = boundOf(node.quantifier);
    const greedy = node.quantifier.greedy !== false;

    if (min === 0 && max === Infinity) {
      this.emitStar(node.expression, greedy);
      return;
    }

    if (min === 1 && max === Infinity) {
      this.emitPlus(node.expression, greedy);
      return;
    }

    for (let i = 0; i < min; i += 1) {
      this.compile(node.expression);
    }

    if (max === Infinity) {
      this.emitStar(node.expression, greedy);
      return;
    }

    const optional = [];

    for (let i = 0; i < max - min; i += 1) {
      const split = this.emit({op: OP.SPLIT});
      const body = this.out.length;

      this.compile(node.expression);
      optional.push({split, body});
    }

    const exit = this.out.length;

    for (const {split, body} of optional) {
      this.out[split].primary = greedy ? body : exit;
      this.out[split].secondary = greedy ? exit : body;
    }
  }

  compile(node) {
    // `a|` stores its empty branch as `null`. Emitting nothing makes the
    // branch fall through, which is exactly an empty match.
    if (!node) {
      return;
    }

    switch (node.type) {
      case 'RegExp':
        this.compile(node.body);
        break;

      case 'Alternative':
        for (const expression of node.expressions) {
          this.compile(expression);
        }
        break;

      case 'Disjunction': {
        const split = this.emit({op: OP.SPLIT});
        const left = this.out.length;

        this.compile(node.left);

        const jump = this.emit({op: OP.JMP});
        const right = this.out.length;

        this.compile(node.right);

        const end = this.out.length;

        this.out[split].primary = left;
        this.out[split].secondary = right;
        this.out[jump].target = end;
        break;
      }

      case 'Group':
        if (node.capturing) {
          const slot = (node.number - 1) * 2;
          this.emit({op: OP.SAVE, slot});
          this.compile(node.expression);
          this.emit({op: OP.SAVE, slot: slot + 1});
          this.groupCount = Math.max(this.groupCount, node.number);
        } else {
          this.compile(node.expression);
        }
        break;

      case 'Repetition':
        this.compileRepetition(node);
        break;

      case 'Char':
      case 'CharacterClass':
        this.emit({op: OP.CHAR, node});
        break;

      case 'Assertion':
        this.emit({op: OP.ASSERT, kind: node.kind});
        break;

      default:
        throw new CompileError(
          `Cannot compile node type "${node.type}"; it should have been ` +
            `rejected by the capability analysis.`
        );
    }
  }

  finish() {
    this.emit({op: OP.MATCH});

    return {
      instructions: this.out,
      markCount: this.markCount,
      groupCount: this.groupCount,
    };
  }
}

function compile(ast) {
  const compiler = new Compiler();
  compiler.compile(ast);
  return compiler.finish();
}

module.exports = {compile, isNullable, OP, CompileError, MAX_INSTRUCTIONS};
