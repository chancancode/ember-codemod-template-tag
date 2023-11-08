import { execSync } from 'node:child_process';

import { findFiles } from '@codemod-utils/files';

import { createOptions } from './steps/index.js';
import unaction, { DeliberateError, NotNecessary } from './steps/unaction.js';
import type { CodemodOptions } from './types/index.js';

export function runCodemod(codemodOptions: CodemodOptions): void {
  const options = createOptions(codemodOptions);

  const candidates = findFiles('**/*.hbs', {
    ignoreList: ['**/node_modules/**'],
    projectRoot: codemodOptions.projectRoot,
  });

  const converted: string[] = [];
  let skipped = 0;
  const groups: Map<string, string[]> = new Map();

  for (const candidate of candidates) {
    const goodRef = execSync('git rev-parse HEAD', {
      cwd: options.projectRoot,
      encoding: 'utf8',
    }).trim();

    try {
      console.log(`Converting ${candidate}`);

      execSync(`git reset --hard ${goodRef}`, {
        cwd: options.projectRoot,
        encoding: 'utf8',
        stdio: 'ignore',
      });

      options.filename = candidate;

      unaction(options);

      console.log(
        execSync(`git show --color HEAD`, {
          cwd: options.projectRoot,
          encoding: 'utf8',
        }),
      );

      converted.push(candidate);
    } catch (error: unknown) {
      if (error instanceof NotNecessary) {
        continue;
      }

      let reason = String(error);

      if (error instanceof Error) {
        reason = error.message;
      }

      reason = reason.trim();

      if (
        !(error instanceof DeliberateError) &&
        !reason.includes(
          'Decorators cannot be used to decorate object literal properties.',
        )
      ) {
        debugger;
      }

      console.warn(`Failed to convert ${candidate}: ${reason}`);

      execSync(`git reset --hard ${goodRef}`, {
        cwd: options.projectRoot,
        stdio: 'ignore',
      });

      skipped++;

      let group = groups.get(reason);

      if (!group) {
        group = [];
        groups.set(reason, group);
      }

      group.push(candidate);
    }
  }

  if (converted.length) {
    console.log('Successfully converted %d files:\n', converted.length);

    for (const file of converted) {
      console.log(`- ${file}`);
    }

    console.log('\n');
  }

  if (skipped) {
    console.log('Skipped %d files:\n', skipped);

    for (const [reason, group] of groups) {
      console.log(`- ${reason}`);
      for (const file of group) {
        console.log(`  - ${file}`);
        console.log(`    ${reason}`);
      }
    }

    console.log('\n');
  }
}
