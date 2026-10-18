import readline from 'node:readline';

export function log(msg) {
  const t = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

// Вопрос в консоли; hidden — не показывать вводимые символы (для пароля)
export function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.startsWith(question)) rl.output.write(question); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}
