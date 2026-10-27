/**
 * Terminal prompts for the one CLI action that must be a person's decision.
 */

import * as readline from 'readline';

/** Whether a person is at this terminal: both ends are a TTY, so a pipe or a script is not. */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Ask a question on the terminal and return the line typed (without the newline). */
export function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
