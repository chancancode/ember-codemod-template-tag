import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AST as AST_JS } from '@codemod-utils/ast-javascript';
import { AST as AST_HBS } from '@codemod-utils/ast-template';

import type { Options } from '../types/index.js';

export class DeliberateError extends Error {}

export class NotEligible extends DeliberateError {
  constructor(reason: string) {
    super(`Not eligible: ${reason}`);
  }
}

export class NotCapable extends DeliberateError {
  constructor(reason: string) {
    super(`Not capable: ${reason}`);
  }
}

export class NotNecessary extends DeliberateError {
  constructor(reason: string) {
    super(`Not necessary: ${reason}`);
  }
}

export class Invalid extends DeliberateError {
  constructor(reason: string) {
    super(`Invalid: ${reason}`);
  }
}

export default function unaction(options: Options): void {
  const hbs = path.join(options.projectRoot, options.filename);

  const js = path.join(
    options.projectRoot,
    options.filename.replace('.hbs', '.js'),
  );

  if (!existsSync(js)) {
    throw new NotEligible('no JS file');
  }

  const jsSource = readFileSync(js, { encoding: 'utf8' });

  // if (jsSource.includes(`.extend(`)) {
  //   throw new NotEligible('classic class');
  // }

  // if (jsSource.includes(`@ember/component`)) {
  //   throw new NotCapable('classic component');
  // }

  const hbsSource = readFileSync(hbs, { encoding: 'utf8' });

  const traverseTemplate = AST_HBS.traverse();

  const actions = new Set<string>();

  const templateAST = traverseTemplate(hbsSource, {
    MustacheStatement(node) {
      if (node.path.type !== 'PathExpression') {
        return;
      }

      if (node.path.original !== 'action') {
        return;
      }

      if (node.params.length === 0) {
        throw new Invalid('{{action}} without any arguments');
      }

      const [action, ...args] = node.params;

      if (action?.type !== 'StringLiteral') {
        console.warn('{{action}} with non-string argument');
        return;
      }

      actions.add(action.value);

      if (node.hash.pairs.length !== 0) {
        return AST_HBS.builders.mustache(
          AST_HBS.builders.path(`--fixme--`),
          [AST_HBS.builders.path(`this.${action.value}`), ...args],
          node.hash,
        );
      } else if (args.length === 0) {
        return AST_HBS.builders.mustache(
          AST_HBS.builders.path(`this.${action.value}`),
        );
      } else {
        // TODO: this is probably easy to swtich to (fn)
        // throw new NotCapable('{{action}} with extra arguments');
        return AST_HBS.builders.mustache(AST_HBS.builders.path(`fn`), [
          AST_HBS.builders.path(`this.${action.value}`),
          ...args,
        ]);
      }
    },

    SubExpression(node) {
      if (node.path.type !== 'PathExpression') {
        return;
      }

      if (node.path.original !== 'action') {
        return;
      }

      if (node.params.length === 0) {
        throw new Invalid('(action) without any arguments');
      }

      const [action, ...args] = node.params;

      if (action?.type !== 'StringLiteral') {
        console.warn('(action) with non-string argument');
        return;
      }

      actions.add(action.value);

      if (node.hash.pairs.length !== 0) {
        return AST_HBS.builders.sexpr(
          AST_HBS.builders.path('--fixme--'),
          [AST_HBS.builders.path(`this.${action.value}`), ...args],
          node.hash,
        );
      } else if (args.length === 0) {
        return AST_HBS.builders.path(`this.${action.value}`);
      } else {
        // TODO: this is probably easy to swtich to (fn)
        // throw new NotCapable('(action) with extra arguments');
        return AST_HBS.builders.sexpr(AST_HBS.builders.path('fn'), [
          AST_HBS.builders.path(`this.${action.value}`),
          ...args,
        ]);
      }
    },
  });

  if (actions.size === 0) {
    throw new NotNecessary('No {{action}} usage');
  }

  const hbsRewritten = AST_HBS.print(templateAST);

  const traverseJS = AST_JS.traverse(false);

  let needsActionImport = true;
  let foundClass = false;

  const jsAST = traverseJS(jsSource, {
    visitImportDeclaration({ node }) {
      if (
        node.source.type === 'Literal' &&
        node.source.value === '@ember/object'
      ) {
        let foundActionImport = false;

        for (const specifier of node.specifiers ?? []) {
          if (
            specifier.type === 'ImportSpecifier' &&
            specifier.imported.type === 'Identifier' &&
            specifier.imported.name === 'action'
          ) {
            if (specifier.local && specifier.local.name !== 'action') {
              throw new NotCapable('Renamed action import');
            }

            foundActionImport = true;
            break;
          }
        }

        if (!foundActionImport) {
          node.specifiers ??= [];
          node.specifiers.push(
            AST_JS.builders.importSpecifier(
              AST_JS.builders.identifier('action'),
            ),
          );
        }

        needsActionImport = false;
      }

      return false;
    },

    visitExportDefaultDeclaration({ node }) {
      if (node.declaration.type !== 'ClassDeclaration') {
        throw new Invalid('Does not export a class');
      }

      for (const item of node.declaration.body.body) {
        if (
          item.type === 'MethodDefinition' &&
          item.kind === 'method' &&
          item.key.type === 'Identifier'
        ) {
          if (actions.has(item.key.name)) {
            item.decorators ??= [];

            let foundActionDecorator = false;

            for (const decorator of item.decorators) {
              if (
                decorator.expression.type === 'Identifier' &&
                decorator.expression.name === 'action'
              ) {
                decorator.expression.name = '__action__';
                foundActionDecorator = true;
                break;
              }
            }

            if (!foundActionDecorator) {
              item.decorators.push(
                AST_JS.builders.decorator(
                  AST_JS.builders.identifier('__action__'),
                ),
              );
            }

            actions.delete(item.key.name);
          }
        }
      }

      if (actions.size !== 0) {
        console.warn(`not found: ${[...actions.values()].join(', ')}`);
        throw new Invalid('Missing some actions');
      }

      foundClass = true;

      return false;
    },
  });

  if (!foundClass) {
    throw new Invalid('Could not find class');
  }

  const jsRewritten = needsActionImport
    ? 'import { action } from "@ember/object";\n' + AST_JS.print(jsAST)
    : AST_JS.print(jsAST);

  writeFileSync(hbs, hbsRewritten, { encoding: 'utf8' });
  writeFileSync(js, jsRewritten, { encoding: 'utf8' });

  execSync(`yarn ember-template-lint --fix ${JSON.stringify(hbs)}`, {
    cwd: options.projectRoot,
  });

  execSync(`yarn prettier --write ${JSON.stringify(hbs)}`, {
    cwd: options.projectRoot,
  });

  execSync(`yarn eslint --fix ${JSON.stringify(js)}`, {
    cwd: options.projectRoot,
  });

  execSync(`yarn prettier --write ${JSON.stringify(js)}`, {
    cwd: options.projectRoot,
  });

  const message = `DEV: {{action}} -> @action ${path.basename(
    options.filename,
  )}`;

  execSync('git add .', { cwd: options.projectRoot });
  execSync(`git commit -m ${JSON.stringify(message)}`, {
    cwd: options.projectRoot,
    stdio: 'ignore',
  });
}
